import { describe, expect, it } from "vitest";
import { EnvironmentProviderError, type CheckpointRef, type CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import { assertForkableCheckpoint, checkpointSnapshotName, createVendorSnapshot, forkCreateInput, vendorSnapshots } from "./checkpoint.js";
import { refuseUnsupportedCreateInput } from "./refusal.js";
import type { BridgeSandboxVendor, BridgeVendorSnapshot } from "./vendor.js";

function vendorWithSnapshots(): BridgeSandboxVendor {
  return {
    name: "fake",
    support: { environment: true, image: false, resources: false, egress: [] },
    snapshots: {
      async create(sandboxId: string, options?: { name?: string; metadata?: Record<string, string>; signal?: AbortSignal }): Promise<BridgeVendorSnapshot> {
        options?.signal?.throwIfAborted();
        return { id: options?.name ?? `snap-${sandboxId}`, createdAt: "2026-11-03T00:00:00.000Z" };
      },
    },
    async create() {
      throw new Error("not under test");
    },
    async connect() {
      return null;
    },
    async list() {
      return [];
    },
  };
}

function vendorWithoutSnapshots(): BridgeSandboxVendor {
  const { snapshots: _snapshots, ...vendor } = vendorWithSnapshots();
  return vendor;
}

describe("vendorSnapshots", () => {
  it("returns the lifecycle when the vendor exposes one", () => {
    expect(vendorSnapshots(vendorWithSnapshots()).create).toBeTypeOf("function");
  });

  it("refuses when the vendor exposes none, naming the vendor", () => {
    expect(() => vendorSnapshots(vendorWithoutSnapshots())).toThrow(EnvironmentProviderError);
    expect(() => vendorSnapshots(vendorWithoutSnapshots())).toThrow(/vendor fake exposes no snapshot lifecycle/);
  });
});

describe("createVendorSnapshot", () => {
  it("returns a checkpoint ref bound to the vendor", async () => {
    const ref = await createVendorSnapshot(vendorWithSnapshots(), "sbx-1");
    expect(ref).toEqual<CheckpointRef>({ id: "snap-sbx-1", provider: "fake", metadata: { createdAt: "2026-11-03T00:00:00.000Z" } });
  });

  it("passes name and string metadata through", async () => {
    const ref = await createVendorSnapshot(vendorWithSnapshots(), "sbx-1", { name: "ckpt", metadata: { run: "42" } });
    expect(ref.id).toBe("ckpt");
  });

  it("refuses non-string snapshot metadata, like vendor tags", async () => {
    await expect(createVendorSnapshot(vendorWithSnapshots(), "sbx-1", { metadata: { count: 2 } })).rejects.toThrow(/count is not a string/);
  });

  it("refuses when the vendor exposes no snapshot lifecycle", async () => {
    await expect(createVendorSnapshot(vendorWithoutSnapshots(), "sbx-1")).rejects.toThrow(EnvironmentProviderError);
  });

  it("propagates aborts to the vendor call", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createVendorSnapshot(vendorWithSnapshots(), "sbx-1", { signal: controller.signal })).rejects.toThrow();
  });
});

describe("assertForkableCheckpoint", () => {
  it("accepts a matching ref", () => {
    expect(() => assertForkableCheckpoint({ id: "snap-1", provider: "fake" }, "fake")).not.toThrow();
  });

  it("accepts a ref with no provider, restoring on this vendor", () => {
    expect(() => assertForkableCheckpoint({ id: "snap-1" }, "fake")).not.toThrow();
  });

  it("refuses a foreign provider's checkpoint", () => {
    expect(() => assertForkableCheckpoint({ id: "snap-1", provider: "e2b" }, "fake")).toThrow(/cannot restore on fake/);
  });

  it("refuses an empty id", () => {
    expect(() => assertForkableCheckpoint({ id: "", provider: "fake" }, "fake")).toThrow(/non-empty id/);
  });
});

describe("forkCreateInput", () => {
  const source: CreateAgentEnvironmentInput = {
    profile: { name: "worker" },
    name: "source-env",
    metadata: { team: "eng" },
    workspace: {
      repoUrl: "https://example.com/repo",
      gitRef: "main",
      environment: "box-template",
      image: "registry/box",
      cwd: { base: "repository", path: "packages/app" },
    },
    signal: AbortSignal.abort(),
  };

  it("drops what the snapshot already carries: repo, git ref, environment and image", () => {
    const forked = forkCreateInput(source);
    expect(forked.workspace).toEqual({ cwd: { base: "repository", path: "packages/app" } });
    expect(forked.profile).toEqual(source.profile);
  });

  it("drops the source signal so a fork outlives the aborted source create", () => {
    expect(forkCreateInput(source).signal).toBeUndefined();
  });

  it("keeps the source name when the request names none, overrides when it does", () => {
    expect(forkCreateInput(source).name).toBe("source-env");
    expect(forkCreateInput(source, { name: "fork-1" }).name).toBe("fork-1");
  });

  it("merges fork metadata over source metadata", () => {
    expect(forkCreateInput(source, { metadata: { lane: "fork" } }).metadata).toEqual({ team: "eng", lane: "fork" });
  });

  it("keeps a workspace-less source workspace-less", () => {
    const bare: CreateAgentEnvironmentInput = { profile: { name: "worker" } };
    expect(forkCreateInput(bare).workspace).toBeUndefined();
  });
});

describe("checkpointSnapshotName", () => {
  it("uses the caller's name when one is given", () => {
    expect(checkpointSnapshotName("named")).toBe("named");
  });

  it("derives a collision-resistant name otherwise", () => {
    const a = checkpointSnapshotName(undefined);
    const b = checkpointSnapshotName(undefined);
    expect(a).toMatch(/^tangle-ckpt-/);
    expect(a).not.toBe(b);
  });
});

describe("create lifetime fields (#309)", () => {
  const support = { environment: true, image: false, resources: false, egress: [] as const };
  it("refuses an idle timeout these sandboxes cannot enforce", () => {
    expect(() => refuseUnsupportedCreateInput({ profile: { name: "w" }, idleTimeoutMs: 60_000 }, support)).toThrow(/lifetime, not an idle timeout/);
  });
  it("accepts a requested hard lifetime the vendor will clamp", () => {
    expect(() => refuseUnsupportedCreateInput({ profile: { name: "w" }, maxLifetimeMs: 60_000 }, support)).not.toThrow();
  });
});
