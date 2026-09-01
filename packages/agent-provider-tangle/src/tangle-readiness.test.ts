import { describe, expect, it, vi } from "vitest";
import type { Sandbox, SandboxInstance } from "@tangle-network/sandbox";
import {
  createTangleProvider,
  DEFAULT_TANGLE_READY_TIMEOUT_MS,
  type SandboxClientLike,
  type SandboxInstanceLike,
} from "./index.js";

/**
 * The linked SDK's own client and instance answer the readiness wait. Both
 * surfaces are optional on the adapter's structural types, so the compiler
 * proves here that the published classes still carry them.
 */
function acceptCurrentSandboxSurfaces(
  client: Sandbox,
  box: SandboxInstance,
): [SandboxClientLike, SandboxInstanceLike] {
  return [client, box];
}

void acceptCurrentSandboxSurfaces;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

function startingBox(
  overrides: Partial<SandboxInstanceLike> = {},
): SandboxInstanceLike {
  return {
    id: "sbx-starting",
    status: "provisioning",
    async *streamPrompt() {},
    ...overrides,
  };
}

function clientFor(
  box: SandboxInstanceLike,
  overrides: Partial<SandboxClientLike> = {},
): SandboxClientLike {
  return {
    async create() {
      return box;
    },
    ...overrides,
  };
}

describe("Tangle create readiness", () => {
  it("does not return the environment until the sandbox is running", async () => {
    const gate = deferred();
    const entered = deferred();
    const box = startingBox({
      waitFor: vi.fn(async () => {
        entered.resolve();
        await gate.promise;
      }),
    });
    const provider = createTangleProvider({ client: clientFor(box) });

    let settled = false;
    const creating = provider
      .create({ profile: { name: "worker" } })
      .then((environment) => {
        settled = true;
        return environment;
      });
    await entered.promise;
    await Promise.resolve();

    expect(box.waitFor).toHaveBeenCalledWith(
      "running",
      expect.objectContaining({ timeoutMs: DEFAULT_TANGLE_READY_TIMEOUT_MS }),
    );
    // The wait is still open, so create() has produced no environment.
    expect(settled).toBe(false);

    gate.resolve();
    const environment = await creating;
    expect(environment.id).toBe("sbx-starting");
  });

  it("carries the configured ready timeout to the platform wait", async () => {
    const box = startingBox({ waitFor: vi.fn(async () => {}) });
    const provider = createTangleProvider({
      client: clientFor(box),
      readyTimeoutMs: 5_000,
    });

    await provider.create({ profile: { name: "worker" } });

    expect(box.waitFor).toHaveBeenCalledWith(
      "running",
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("refuses a ready timeout that cannot bound a wait", () => {
    const box = startingBox({ waitFor: async () => {} });
    for (const readyTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createTangleProvider({ client: clientFor(box), readyTimeoutMs }),
      ).toThrow(/readyTimeoutMs must be a positive number/);
    }
  });

  it("fails create with the platform's reason and releases the sandbox", async () => {
    const failure = new Error("Sandbox failed: image pull refused");
    const deleted = vi.fn(async () => undefined);
    const box = startingBox({
      waitFor: async () => {
        throw failure;
      },
      delete: deleted,
    });
    const provider = createTangleProvider({ client: clientFor(box) });

    await expect(
      provider.create({ profile: { name: "worker" } }),
    ).rejects.toThrow(/sbx-starting did not reach running.*image pull refused/);
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("keeps the platform failure reachable as the cause", async () => {
    const failure = new Error("Timed out waiting for sandbox to reach running");
    const box = startingBox({
      waitFor: async () => {
        throw failure;
      },
      delete: async () => undefined,
    });
    const provider = createTangleProvider({ client: clientFor(box) });

    const error = await provider
      .create({ profile: { name: "worker" } })
      .catch((reason: unknown) => reason);
    expect((error as { cause?: unknown }).cause).toBe(failure);
  });

  it("keeps an aborted create an abort", async () => {
    const controller = new AbortController();
    const deleted = vi.fn(async () => undefined);
    const box = startingBox({
      waitFor: async () => {
        controller.abort();
        await new Promise(() => {});
      },
      delete: deleted,
    });
    const provider = createTangleProvider({ client: clientFor(box) });

    const error = await provider
      .create({ profile: { name: "worker" }, signal: controller.signal })
      .catch((reason: unknown) => reason);
    expect((error as Error).name).toBe("AbortError");
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("uses the client wait and refreshes the created instance", async () => {
    const calls: string[] = [];
    const box = startingBox({
      refresh: vi.fn(async () => {
        calls.push("refresh");
      }),
    });
    const waitForRunning = vi.fn(async () => {
      calls.push("waitForRunning");
      return startingBox({ id: box.id, status: "running" });
    });
    const provider = createTangleProvider({
      client: clientFor(box, { waitForRunning }),
      readyTimeoutMs: 7_000,
    });

    await provider.create({ profile: { name: "worker" } });

    expect(waitForRunning).toHaveBeenCalledWith(
      "sbx-starting",
      expect.objectContaining({ timeoutMs: 7_000 }),
    );
    expect(calls).toEqual(["waitForRunning", "refresh"]);
  });

  it("refuses to return a starting sandbox it cannot wait for", async () => {
    const deleted = vi.fn(async () => undefined);
    const box = startingBox({ delete: deleted });
    const provider = createTangleProvider({ client: clientFor(box) });

    await expect(
      provider.create({ profile: { name: "worker" } }),
    ).rejects.toThrow(
      /cannot return a sandbox that is still provisioning.*neither instance waitFor\(\) nor client waitForRunning\(\)/s,
    );
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("waits for a sandbox that reports no status", async () => {
    // No status is no evidence of a lifecycle in progress, so the adapter does
    // not invent one; it still asks the platform when the platform can answer.
    const box: SandboxInstanceLike = {
      id: "sbx-quiet",
      waitFor: vi.fn(async () => {}),
      async *streamPrompt() {},
    };
    const provider = createTangleProvider({ client: clientFor(box) });

    const environment = await provider.create({ profile: { name: "worker" } });

    expect(environment.id).toBe("sbx-quiet");
    expect(box.waitFor).toHaveBeenCalledTimes(1);
  });

  it("returns a sandbox that reports neither a status nor a wait", async () => {
    const box: SandboxInstanceLike = {
      id: "sbx-silent",
      async *streamPrompt() {},
    };
    const provider = createTangleProvider({ client: clientFor(box) });

    await expect(
      provider.create({ profile: { name: "worker" } }),
    ).resolves.toMatchObject({ id: "sbx-silent" });
  });

  it("waits once per created environment, not once per idempotent replay", async () => {
    const box = startingBox({ waitFor: vi.fn(async () => {}) });
    const provider = createTangleProvider({ client: clientFor(box) });
    const input = {
      profile: { name: "worker" },
      idempotencyKey: "create-1",
    } as const;

    await provider.create({ ...input });
    await provider.create({ ...input });

    expect(box.waitFor).toHaveBeenCalledTimes(1);
  });
});
