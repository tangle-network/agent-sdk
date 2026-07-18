import { describe, expect, it, vi } from "vitest";
import {
  runAgentEnvironmentProviderConformance,
  runAgentExactProcessProviderLifecycleChecks,
} from "@tangle-network/agent-provider-testkit";
import {
  createExactProcessAttestation,
  type CreateSandboxOptions,
  type ExactProcessAttestation,
  type SandboxEvent,
} from "@tangle-network/sandbox";
import {
  createTangleProvider,
  defaultTangleSandboxCapabilities,
  type SandboxClientLike,
  type SandboxInstanceLike,
} from "./index.js";

const EXACT_IMAGE = `example/image@sha256:${"1".repeat(64)}`;
const EXACT_LOCAL_IMAGE = `sha256:${"2".repeat(64)}`;
const EXACT_RESOURCES = { cpu: 1, memoryMb: 512, diskMb: 1024 } as const;

describe("createTangleProvider", () => {
  it("refuses to advertise exact processes without the exact adapter", async () => {
    const provider = createTangleProvider({
      client: {
        async create() {
          throw new Error("not called");
        },
      },
      capabilities: {
        ...defaultTangleSandboxCapabilities(),
        exactProcess: { egress: ["blocked"] },
      },
    });

    await expect(provider.capabilities()).rejects.toThrow(
      "cannot advertise exactProcess",
    );
    expect(defaultTangleSandboxCapabilities()).not.toHaveProperty(
      "exactProcess",
    );
  });

  it("maps create options, stream events, workspace methods, and dispatch sessions", async () => {
    let createOptions: CreateSandboxOptions | undefined;
    const files = new Map<string, string>();
    const box: SandboxInstanceLike = {
      id: "sbx-1",
      name: "sandbox-one",
      status: "running",
      async *streamPrompt(prompt: string): AsyncIterable<SandboxEvent> {
        yield {
          type: "result",
          data: {
            finalText: `ok:${prompt}`,
            usage: { inputTokens: 2, outputTokens: 3, totalCostUsd: 0.01 },
          },
        } as SandboxEvent;
      },
      dispatchPrompt: async () => ({ sessionId: "sess-1", status: "running", alreadyExisted: true }),
      read: async (path) => files.get(path) ?? "",
      write: async (path, content) => {
        files.set(path, content);
      },
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
      delete: async () => {},
    };
    const client: SandboxClientLike = {
      async create(options) {
        createOptions = options;
        return box;
      },
      describePlacement: () => ({ kind: "sibling", sandboxId: "sbx-1" }),
    };
    const provider = createTangleProvider({ client });

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "sandbox",
        createProvider: () => provider,
        createInput: { profile: { name: "worker" }, backend: "codex" },
      }),
    ).resolves.toMatchObject({ provider: "tangle-sandbox" });

    expect(createOptions).toMatchObject({
      backend: { type: "codex", profile: { name: "worker" } },
    });
    const environment = await provider.create({ profile: "worker", backend: "codex" });
    await expect(environment.dispatch?.({ prompt: "go" })).resolves.toMatchObject({
      id: "sess-1",
      metadata: { alreadyExisted: true },
    });
  });

  it("does not delete an idempotently recovered environment when adaptation fails", async () => {
    const deleted = vi.fn(async () => undefined);
    const box: SandboxInstanceLike = {
      id: "exact-recovered",
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      delete: deleted,
    };
    const client: SandboxClientLike = {
      async create(options) {
        box.exactProcess = await createExactProcessAttestation(options ?? {});
        return box;
      },
      async get() {
        return box;
      },
      async list() {
        return [box];
      },
    };
    const provider = createTangleProvider({ client, exactProcess: {} });

    await expect(
      provider.exactProcess?.create({
        image: EXACT_IMAGE,
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: EXACT_RESOURCES,
        metadata: { executionId: "recovered" },
        idempotencyKey: "candidate-recovered",
      }),
    ).rejects.toThrow("does not expose exact files, processes, and deletion");
    expect(deleted).not.toHaveBeenCalled();
  });

  it("creates a recoverable bare exact-process environment without ambient access", async () => {
    let createOptions: CreateSandboxOptions | undefined;
    let createRequestOptions: { signal?: AbortSignal; timeoutMs?: number } | undefined;
    let listOptions: Record<string, unknown> | undefined;
    let write:
      | {
          path: string;
          content: string;
          options: { encoding: "base64"; mode: number; signal?: AbortSignal };
        }
      | undefined;
    let launch:
      | {
          executable: string;
          args: readonly string[];
          options?: {
            cwd?: string;
            env?: Record<string, string>;
            inheritEnv?: boolean;
            stdin?: string;
            timeoutMs?: number;
            signal?: AbortSignal;
          };
        }
      | undefined;
    let spawned = false;
    let deleted = false;
    let boundIdempotencyKey: string | undefined;
    let attestExact = true;
    let statusFails = false;
    let killCalls = 0;
    let listedBoxes: SandboxInstanceLike[] | undefined;
    let attestationOverride: ExactProcessAttestation | undefined;
    const writtenFiles = new Map<string, Uint8Array>();
    const status = {
      pid: 73,
      running: false,
      exitCode: 0,
      termination: { kind: "exit" as const, exitCode: 0 },
    };
    const process = {
      pid: 73,
      status: async () => {
        if (statusFails) throw new Error("not found");
        return status;
      },
      wait: async () => 0,
      waitForTermination: async () => status.termination,
      kill: async () => {
        killCalls++;
      },
      async *stdout() {
        yield "ok";
      },
      async *stderr() {},
    };
    const box: SandboxInstanceLike = {
      id: "exact-1",
      status: "running",
      metadata: { executionId: "execution-1", nested: { attempt: 1 } },
      async *streamPrompt(): AsyncIterable<SandboxEvent> {
        yield { type: "result", data: {} } as SandboxEvent;
      },
      fs: {
        supportsWriteMode: true,
        async readBytes(path, options) {
          const bytes = writtenFiles.get(path);
          if (!bytes) throw new Error("not found");
          if (bytes.byteLength > options.maxBytes) {
            throw new Error("file exceeds maxBytes");
          }
          return bytes;
        },
        async write(path, content, options) {
          write = { path, content, options };
          writtenFiles.set(path, Buffer.from(content, "base64"));
        },
      },
      process: {
        list: async () => (spawned ? [status] : []),
        get: async (pid) => (spawned && pid === process.pid ? process : null),
        async spawnExact(executable, args, options) {
          spawned = true;
          launch = { executable, args, options };
          return process;
        },
      },
      async delete() {
        deleted = true;
      },
    };
    const client: SandboxClientLike = {
      async create(options, requestOptions) {
        if (
          !deleted &&
          boundIdempotencyKey === options?.idempotencyKey &&
          box.exactProcess
        ) {
          return box;
        }
        createOptions = options;
        createRequestOptions = requestOptions;
        deleted = false;
        spawned = false;
        writtenFiles.clear();
        boundIdempotencyKey = options?.idempotencyKey;
        box.metadata = { ...(options?.metadata ?? {}) };
        box.exactProcess =
          attestExact && options?.exactProcess
            ? (attestationOverride ?? (await createExactProcessAttestation(options)))
            : undefined;
        box.teamId = options?.teamId;
        return box;
      },
      async get(id) {
        return id === box.id && !deleted ? box : null;
      },
      async list(options) {
        listOptions = options as Record<string, unknown>;
        if (deleted) return [];
        if (!listedBoxes) return [box];
        const offset = Number(listOptions.offset ?? 0);
        const limit = Number(listOptions.limit ?? 100);
        return listedBoxes.slice(offset, offset + limit);
      },
    };
    const provider = createTangleProvider({
      client,
      exactProcess: { teamId: "team-1" },
    });

    await expect(
      runAgentExactProcessProviderLifecycleChecks({
        createProvider: () => provider,
        createInput: {
          image: EXACT_IMAGE,
          egress: { mode: "strict", allowDomains: ["model.example"] },
          maxLifetimeMs: 61_000,
          provisionTimeoutMs: 3_000,
          resources: EXACT_RESOURCES,
          metadata: { executionId: "execution-1", nested: { attempt: 1 } },
          idempotencyKey: "candidate-1",
        },
        launch: {
          executable: "/usr/bin/agent",
          args: ["--prompt", "hello world"],
          cwd: "/workspace",
          env: { MODEL_URL: "http://model.internal" },
          stdin: "input",
          timeoutMs: 2_000,
        },
        expectedStdout: "ok",
        expectedStderr: "",
      }),
    ).resolves.toMatchObject({ provider: "tangle-sandbox", environmentId: "exact-1" });

    expect(createOptions).toEqual({
      image: EXACT_IMAGE,
      exactProcess: true,
      publicEdge: false,
      ephemeral: true,
      sshEnabled: false,
      webTerminalEnabled: false,
      secrets: [],
      capabilities: [],
      egressPolicy: {
        mode: "strict",
        allowDomains: ["model.example"],
        includeImplicitDomains: false,
      },
      maxLifetimeSeconds: 61,
      idempotencyKey: "candidate-1",
      metadata: { executionId: "execution-1", nested: { attempt: 1 } },
      teamId: "team-1",
      resources: { cpuCores: 1, memoryMB: 512, diskGB: 1 },
    });
    expect(createRequestOptions?.timeoutMs).toBe(3_000);
    expect(write).toEqual({
      path: "/tmp/agent-provider-testkit.bin",
      content: "AAEC/w==",
      options: {
        encoding: "base64",
        mode: 0o640,
        signal: expect.any(AbortSignal),
      },
    });
    expect(launch).toEqual({
      executable: "/usr/bin/agent",
      args: ["--prompt", "hello world"],
      options: {
        cwd: "/workspace",
        env: { MODEL_URL: "http://model.internal" },
        inheritEnv: false,
        stdin: "input",
        timeoutMs: 2_000,
        signal: expect.any(AbortSignal),
      },
    });
    expect(listOptions).toMatchObject({ scope: "team:team-1", limit: 100, offset: 0 });
    expect(deleted).toBe(true);

    const exact = provider.exactProcess;
    expect(exact).toBeDefined();
    const environment = await exact!.create({
      image: EXACT_LOCAL_IMAGE,
      egress: { mode: "blocked" },
      maxLifetimeMs: 10_000,
      resources: EXACT_RESOURCES,
      metadata: { executionId: "execution-2" },
      idempotencyKey: "candidate-2",
    });
    await expect(
      environment.process.spawn({
        executable: "agent",
        args: [],
        cwd: "/workspace",
        env: {},
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("executable must be absolute");
    expect(spawned).toBe(false);
    const staleProcess = await environment.process.spawn({
      executable: "/usr/bin/agent",
      args: [],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1_000,
    });
    const killCallsBeforeStaleHandle = killCalls;
    statusFails = true;
    await expect(staleProcess.kill()).resolves.toBeUndefined();
    expect(killCalls).toBe(killCallsBeforeStaleHandle + 1);
    statusFails = false;
    await expect(
      environment.writeFile("relative", Uint8Array.of(1), { mode: 0o644 }),
    ).rejects.toThrow("file path must be absolute");
    await expect(
      environment.writeFile("/tmp/file", Uint8Array.of(1), { mode: 0o10000 }),
    ).rejects.toThrow("file mode");
    await environment.destroy();

    deleted = false;
    box.metadata = { executionId: "ordinary", exactProcess: true };
    box.exactProcess = undefined;
    box.teamId = "team-1";
    await expect(exact!.get(box.id)).resolves.toBeNull();
    await expect(exact!.list()).resolves.toEqual([]);

    const paginationAttestation = await createExactProcessAttestation({
      image: EXACT_IMAGE,
      egressPolicy: { mode: "blocked" },
      maxLifetimeSeconds: 10,
      metadata: { campaign: "pagination" },
      teamId: "team-1",
    });
    listedBoxes = Array.from({ length: 101 }, (_, index) => ({
      ...box,
      id: `exact-${index}`,
      exactProcess: paginationAttestation,
      teamId: "team-1",
      metadata: { campaign: "pagination" },
    }));
    const paginated = await exact!.list({ metadata: { campaign: "pagination" } });
    expect(paginated).toHaveLength(101);
    expect(listOptions).toMatchObject({ offset: 100, limit: 100 });
    listedBoxes = undefined;

    attestationOverride = await createExactProcessAttestation({
      image: EXACT_IMAGE,
      egressPolicy: { mode: "blocked" },
      maxLifetimeSeconds: 10,
      metadata: { executionId: "old-input" },
      teamId: "team-1",
    });
    await expect(
      exact!.create({
        image: `example/other@sha256:${"2".repeat(64)}`,
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: EXACT_RESOURCES,
        metadata: { executionId: "new-input" },
        idempotencyKey: "candidate-collision",
      }),
    ).rejects.toThrow("idempotency collision");
    attestationOverride = undefined;

    attestExact = false;
    await expect(
      exact!.create({
        image: EXACT_IMAGE,
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: EXACT_RESOURCES,
        metadata: { executionId: "collision" },
        idempotencyKey: "candidate-unattested",
      }),
    ).rejects.toThrow("did not attest");
    expect(deleted).toBe(false);
    await expect(
      exact!.create({
        image: EXACT_IMAGE,
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: EXACT_RESOURCES,
        metadata: { exactProcess: true },
        idempotencyKey: "candidate-reserved-metadata",
      }),
    ).rejects.toThrow("metadata is reserved");
  });
});
