import { describe, expect, it, vi } from "vitest";
import type { Sandbox, SandboxInstance } from "@tangle-network/sandbox";
import {
  createTangleProvider,
  DEFAULT_TANGLE_READY_TIMEOUT_MS,
  type SandboxClientLike,
  type SandboxInstanceLike,
} from "./index.js";

/**
 * The readiness wait calls two SDK methods through optional structural members,
 * which an implementation missing them would still satisfy. Binding each method
 * to the type the adapter calls it as makes the compiler prove the published
 * classes still carry them, and carry them with a compatible signature.
 */
function pinSandboxWaitSurfaces(
  client: Sandbox,
  box: SandboxInstance,
): [
  NonNullable<SandboxClientLike["waitForRunning"]>,
  NonNullable<SandboxInstanceLike["waitFor"]>,
] {
  return [
    (id, options) => client.waitForRunning(id, options),
    (status, options) => box.waitFor(status, options),
  ];
}

void pinSandboxWaitSurfaces;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

/** Let every pending microtask and timer callback run. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * A sandbox that starts provisioning and reaches running through its own wait,
 * which is what `SandboxInstance.waitFor` does: it refreshes in place until the
 * platform reports the target.
 */
function startingBox(
  overrides: Partial<SandboxInstanceLike> = {},
): SandboxInstanceLike {
  const box: SandboxInstanceLike = {
    id: "sbx-starting",
    status: "provisioning",
    async waitFor() {
      box.status = "running";
    },
    async *streamPrompt() {},
  };
  return Object.assign(box, overrides);
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
    const box = startingBox();
    box.waitFor = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
      box.status = "running";
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
    // A timer flush runs every pending microtask, so a create that did not
    // await the wait would already have settled by this line.
    await drain();

    expect(box.waitFor).toHaveBeenCalledWith(
      "running",
      expect.objectContaining({ timeoutMs: DEFAULT_TANGLE_READY_TIMEOUT_MS }),
    );
    expect(settled).toBe(false);

    gate.resolve();
    await expect(creating).resolves.toMatchObject({ id: "sbx-starting" });
  });

  it("carries the configured ready timeout to the platform wait", async () => {
    const box = startingBox();
    box.waitFor = vi.fn(async () => {
      box.status = "running";
    });
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
    const box = startingBox();
    for (const readyTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createTangleProvider({ client: clientFor(box), readyTimeoutMs }),
      ).toThrow(/readyTimeoutMs must be a positive number/);
    }
  });

  it("refuses a wait that resolves over a sandbox that is not running", async () => {
    // The platform owns the wait, but its answer is read back. A wait that
    // resolves while the sandbox still reports provisioning would otherwise
    // hand the caller the half-started environment this gate exists to refuse.
    const deleted = vi.fn(async () => undefined);
    const box = startingBox({ waitFor: async () => {}, delete: deleted });

    await expect(
      createTangleProvider({ client: clientFor(box) }).create({
        profile: { name: "worker" },
      }),
    ).rejects.toThrow(
      /cannot return sandbox sbx-starting: it reports provisioning and its wait resolved without reaching running/,
    );
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("refuses a settled sandbox the platform never started", async () => {
    for (const status of ["failed", "stopped", "expired"] as const) {
      const box = startingBox({ status, waitFor: async () => {} });
      await expect(
        createTangleProvider({ client: clientFor(box) }).create({
          profile: { name: "worker" },
        }),
      ).rejects.toThrow(new RegExp(`it reports ${status}`));
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

  it("keeps an abort raised during the wait an abort", async () => {
    const controller = new AbortController();
    const deleted = vi.fn(async () => undefined);
    const entered = deferred();
    const box = startingBox({
      // The wait is in flight when the abort lands, so the rejection comes from
      // the wait's own race rather than from an entry guard.
      waitFor: async () => {
        entered.resolve();
        await new Promise(() => {});
      },
      delete: deleted,
    });
    const provider = createTangleProvider({ client: clientFor(box) });

    const creating = provider
      .create({ profile: { name: "worker" }, signal: controller.signal })
      .catch((reason: unknown) => reason);
    await entered.promise;
    await drain();
    controller.abort();

    expect((await creating as Error).name).toBe("AbortError");
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("uses the client wait and refreshes the created instance", async () => {
    const calls: string[] = [];
    const box: SandboxInstanceLike = {
      id: "sbx-starting",
      status: "provisioning",
      refresh: vi.fn(async () => {
        calls.push("refresh");
        box.status = "running";
      }),
      async *streamPrompt() {},
    };
    const waitForRunning = vi.fn(async () => {
      calls.push("waitForRunning");
      return { ...box, status: "running" } as SandboxInstanceLike;
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

  it("refuses a client wait that answers about a different sandbox", async () => {
    const box = startingBox({ waitFor: undefined, delete: async () => undefined });
    const provider = createTangleProvider({
      client: clientFor(box, {
        waitForRunning: async () =>
          ({ id: "sbx-other", status: "running" }) as SandboxInstanceLike,
      }),
    });

    await expect(
      provider.create({ profile: { name: "worker" } }),
    ).rejects.toThrow(/its wait resolved without reaching running/);
  });

  it("refuses to return a sandbox it cannot wait for", async () => {
    const deleted = vi.fn(async () => undefined);
    const box = startingBox({ waitFor: undefined, delete: deleted });
    const provider = createTangleProvider({ client: clientFor(box) });

    await expect(
      provider.create({ profile: { name: "worker" } }),
    ).rejects.toThrow(
      /it reports provisioning and the linked client provides neither instance waitFor\(\) nor client waitForRunning\(\)/,
    );
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("returns a running sandbox without asking the platform twice", async () => {
    // A client with no wait is still usable when the sandbox it returned proves
    // readiness by itself.
    const box: SandboxInstanceLike = {
      id: "sbx-ready",
      status: "running",
      async *streamPrompt() {},
    };

    await expect(
      createTangleProvider({ client: clientFor(box) }).create({
        profile: { name: "worker" },
      }),
    ).resolves.toMatchObject({ id: "sbx-ready" });
  });

  it("waits once per created environment, not once per idempotent replay", async () => {
    const box = startingBox();
    box.waitFor = vi.fn(async () => {
      box.status = "running";
    });
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
