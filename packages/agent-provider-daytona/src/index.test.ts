import { describe, expect, it, vi } from "vitest";
import { runAgentEnvironmentProviderConformance, runWorkspaceSnapshotConformance } from "@tangle-network/agent-provider-testkit";
import { createDaytonaProvider, type DaytonaLike, type DaytonaSandboxLike } from "./index.js";

describe("createDaytonaProvider", () => {
  it("refuses portable workspace snapshots before effects after reconstruction", async () => {
    let effects = 0;
    const report = await runWorkspaceSnapshotConformance({
      name: "daytona",
      createProvider: () => createDaytonaProvider({ daytona: { create: async () => { effects++; throw new Error("unexpected create"); } } }),
      effectCount: () => effects,
    });
    expect(report.checked).toContain("workspace-snapshot-zero-effects");
    expect(effects).toBe(0);
  });

  it("refuses keyed creates before remote effects across restart and lost acknowledgements", async () => {
    let creates = 0;
    let loseAcknowledgement = false;
    const remoteCreate = async () => {
      creates += 1;
      if (loseAcknowledgement) throw new Error("create acknowledgement lost");
      return { id: `remote-${creates}`, sandboxId: `remote-${creates}`, state: "started" };
    };
    const options = { daytona: { create: remoteCreate } };
    const first = createDaytonaProvider(options);
    const input = { profile: "worker", idempotencyKey: "operation-1" };
    await expect(first.create({ profile: "worker", runtimeAttachments: { mcp: {} } })).rejects.toThrow(/does not support runtime MCP attachments/);
    await expect(first.create(input)).rejects.toThrow(/does not support durable keyed creation/);
    const restarted = createDaytonaProvider(options);
    await expect(restarted.create(input)).rejects.toThrow(/does not support durable keyed creation/);
    await expect(restarted.create({ ...input, profile: "changed" })).rejects.toThrow(/does not support durable keyed creation/);
    expect(creates).toBe(0);

    expect((await first.create({ profile: "worker" })).id).toBe("remote-1");
    loseAcknowledgement = true;
    await expect(first.create({ profile: "worker" })).rejects.toThrow("create acknowledgement lost");
    expect(creates).toBe(2);
    await expect(createDaytonaProvider(options).create(input)).rejects.toThrow(/does not support durable keyed creation/);
    expect(creates).toBe(2);
  });

  it("wraps Daytona workspaces as provider environments", async () => {
    const files = new Map<string, string>();
    const daytona: DaytonaLike = {
      async create() {
        return {
          id: "daytona-1",
          state: "started",
          process: {
            executeCommand: async (command: string) => ({ exitCode: 0, stdout: `ran:${command}`, stderr: "" }),
          },
          fs: {
            readFile: async (path: string) => files.get(path) ?? "",
            writeFile: async (path: string, content: string) => {
              files.set(path, content);
            },
          },
          delete: async () => {},
        };
      },
    };
    const provider = createDaytonaProvider({
      daytona,
      turnCommand: ({ prompt }) => `agent ${prompt}`,
    });

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "daytona",
        createProvider: () => provider,
        keyedCreate: "unsupported",
      }),
    ).resolves.toMatchObject({ provider: "daytona" });

    const environment = await provider.create({ profile: "worker" });
    const events = [];
    for await (const event of environment.stream({ prompt: "hello" })) events.push(event);
    expect(events.at(-1)).toMatchObject({ data: { finalText: "ran:agent hello" } });
  });

  it("recovers only the recorded ID after adapter reconstruction without another create", async () => {
    const create = vi.fn(async () => ({ id: "recorded-id", state: "started" }));
    const get = vi.fn(async () => ({ id: "recorded-id", state: "started" }));
    const first = createDaytonaProvider({ daytona: { create, get } });
    const environment = await first.create({ profile: "worker" });
    expect(environment.creation).toBe("created");
    const restarted = createDaytonaProvider({ daytona: { create, get } });
    const recovered = await restarted.get!(environment.id);
    expect(recovered?.id).toBe(environment.id);
    expect(recovered?.creation).toBeUndefined();
    expect(get).toHaveBeenCalledWith("recorded-id");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused name that Daytona resolves to another sandbox", async () => {
    const create = vi.fn();
    const deleteSandbox = vi.fn();
    const get = vi.fn(async () => ({ id: "replacement-id", state: "started", delete: deleteSandbox }));
    const provider = createDaytonaProvider({ daytona: { create, get } });
    await expect(provider.get!("recorded-id")).rejects.toThrow(/identity does not match/);
    expect(create).not.toHaveBeenCalled();
    expect(deleteSandbox).not.toHaveBeenCalled();
  });

  it("maps only structured lookup 404 to absence and preserves service failures", async () => {
    const create = vi.fn();
    const missing = Object.assign(new Error("sandbox not found"), { statusCode: 404 });
    const get = vi.fn(async (): Promise<DaytonaSandboxLike> => { throw missing; });
    const provider = createDaytonaProvider({ daytona: { create, get } });
    await expect(provider.get!("recorded-id")).resolves.toBeNull();
    for (const error of [new Error("sandbox not found"), Object.assign(new Error("unavailable"), { statusCode: 503 })]) {
      get.mockRejectedValueOnce(error);
      await expect(provider.get!("recorded-id")).rejects.toBe(error);
    }
    expect(create).not.toHaveBeenCalled();
    await expect(createDaytonaProvider({ daytona: { create } }).get!("recorded-id")).rejects.toThrow(/does not expose a sandbox lookup API/);
  });

  it("honors recovery cancellation before and after the read", async () => {
    const before = new AbortController();
    before.abort();
    const get = vi.fn(async () => ({ id: "recorded-id", state: "started" }));
    const provider = createDaytonaProvider({ daytona: { create: vi.fn(), get } });
    await expect(provider.get!("recorded-id", { signal: before.signal })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    const after = new AbortController();
    get.mockImplementationOnce(async () => {
      after.abort();
      return { id: "recorded-id", state: "started" };
    });
    await expect(provider.get!("recorded-id", { signal: after.signal })).rejects.toThrow();
  });

  it("waits for creation readiness and refuses unknown or failed creates", async () => {
    const sandbox = { id: "recorded-id", state: "starting", waitUntilStarted: vi.fn(async () => { sandbox.state = "started"; }) };
    const create = vi.fn(async () => sandbox);
    const provider = createDaytonaProvider({ daytona: { create } });
    await expect(provider.create({ profile: "worker" })).resolves.toMatchObject({ id: "recorded-id" });
    expect(sandbox.waitUntilStarted).toHaveBeenCalledTimes(1);
    for (const state of ["starting", "error", "build_failed", "stopped", "future-state", undefined]) {
      const candidate = createDaytonaProvider({ daytona: { create: async () => ({ id: "unready-id", state }) } });
      await expect(candidate.create({ profile: "worker" })).rejects.toThrow(/did not return a running sandbox/);
    }
    const waitUntilStarted = vi.fn();
    await expect(createDaytonaProvider({ daytona: { create: async () => ({ id: "failed-id", state: "error", waitUntilStarted }) } }).create({ profile: "worker" })).rejects.toThrow(/did not return a running sandbox/);
    expect(waitUntilStarted).not.toHaveBeenCalled();
  });

  it.each([
    ["started", "running"], ["starting", "provisioning"], ["stopping", "provisioning"],
    ["restoring", "provisioning"], ["pending_build", "pending"], ["stopped", "stopped"],
    ["paused", "stopped"], ["archived", "stopped"], ["error", "failed"],
    ["build_failed", "failed"], ["destroyed", "expired"], ["future-state", "unknown"],
  ])("reports Daytona %s as %s on recovery and listing", async (state, status) => {
    const sandbox = { id: "recorded-id", state };
    const provider = createDaytonaProvider({ daytona: { create: vi.fn(), get: async () => sandbox, list: async () => [sandbox] } });
    expect(await (await provider.get!(sandbox.id))!.status()).toBe(status);
    expect((await provider.list!())[0]?.status).toBe(status);
  });

  it("refreshes lifecycle state and refuses execution while the sandbox is stopped", async () => {
    const executeCommand = vi.fn(async () => ({ exitCode: 0, result: "ok" }));
    const sandbox = { id: "recorded-id", state: "started", process: { executeCommand }, refreshData: vi.fn(async () => { sandbox.state = "stopped"; }) };
    const provider = createDaytonaProvider({ daytona: { create: vi.fn(), get: async () => sandbox } });
    const recovered = (await provider.get!(sandbox.id))!;
    await expect(recovered.status()).resolves.toBe("stopped");
    await expect(recovered.exec!("run")).rejects.toThrow(/cannot execute while stopped/);
    expect(sandbox.refreshData).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalled();
    sandbox.refreshData.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 404 }));
    await expect(recovered.status()).resolves.toBe("expired");
    sandbox.refreshData.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { statusCode: 503 }));
    await expect(recovered.status()).rejects.toThrow("unavailable");
  });

  it("keeps the recorded identity after refreshing provider data", async () => {
    const sandbox = { id: "recorded-id", state: "started", refreshData: vi.fn(async () => { sandbox.id = "replacement-id"; }) };
    const provider = createDaytonaProvider({ daytona: { create: vi.fn(), get: async () => sandbox } });
    const recovered = (await provider.get!(sandbox.id))!;
    await expect(recovered.status()).rejects.toThrow(/identity does not match/);
  });

  it("passes cwd, environment, and seconds to the documented Daytona execution API", async () => {
    const executeCommand = vi.fn(async () => ({ exitCode: 0, result: "ok" }));
    const refreshData = vi.fn();
    const provider = createDaytonaProvider({ daytona: { create: vi.fn(), get: async () => ({ id: "recorded-id", state: "started", process: { executeCommand }, refreshData }) } });
    const recovered = (await provider.get!("recorded-id"))!;
    await expect(recovered.exec!("run", { cwd: "/work", env: { MODE: "test" }, timeoutMs: 1500 })).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(executeCommand).toHaveBeenCalledWith("run", "/work", { MODE: "test" }, 1.5);
    expect(refreshData).not.toHaveBeenCalled();
  });

  it("never reports destruction by stopping a retained resource", async () => {
    const stop = vi.fn();
    const provider = createDaytonaProvider({ daytona: { create: vi.fn(), get: async () => ({ id: "recorded-id", state: "started", stop }) } });
    await expect((await provider.get!("recorded-id"))!.destroy!()).rejects.toThrow(/does not expose a delete API/);
    expect(stop).not.toHaveBeenCalled();
  });

  it("accepts repeated deletion only when the provider proves absence", async () => {
    const remove = vi.fn(async () => { throw Object.assign(new Error("gone"), { statusCode: 404 }); });
    const provider = createDaytonaProvider({ daytona: { create: vi.fn(), get: async () => ({ id: "recorded-id", state: "started", remove }) } });
    const recovered = (await provider.get!("recorded-id"))!;
    await expect(recovered.destroy!()).resolves.toBeUndefined();
    remove.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    await expect(recovered.destroy!()).rejects.toThrow("forbidden");
  });
});
