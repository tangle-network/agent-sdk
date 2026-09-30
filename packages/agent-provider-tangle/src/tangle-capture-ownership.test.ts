import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createTangleProvider } from "./tangle-provider.js";
import { createTangleExactProcessProvider } from "./exact-process.js";
import type { SandboxClientLike, SandboxInstanceLike } from "./tangle-types.js";

describe.each(["agent", "process"] as const)("%s create cancellation ownership", (kind) => {
  it.each(["created", "idempotent_replay", "missing"] as const)("preserves ownership when a late %s response follows abort", async (outcome) => {
    let resolveBox!: (box: SandboxInstanceLike) => void;
    let entered!: () => void;
    const admission = new Promise<void>((resolve) => { entered = resolve; });
    const late = new Promise<SandboxInstanceLike>((resolve) => { resolveBox = resolve; });
    const deleted = vi.fn(async () => undefined);
    const box: SandboxInstanceLike = {
      id: "late-box", status: "running", async *streamPrompt() {}, delete: deleted,
      createReceipt: () => outcome === "missing" ? null : { outcome, idempotencyKeyApplied: true },
    };
    const client: SandboxClientLike = {
      create: async () => { entered(); return late; },
      get: async () => null,
      list: async () => [],
    };
    const controller = new AbortController();
    const pending = kind === "agent"
      ? createTangleProvider({ client, requireNativeSessionCapture: true }).create({
          profile: { name: "worker", harness: "opencode" }, signal: controller.signal,
        })
      : createTangleExactProcessProvider({ client, options: {}, providerName: "tangle-sandbox", readyTimeoutMs: 1_000, requireNativeSessionCapture: true }).create({
          image: `sha256:${"a".repeat(64)}`, egress: { mode: "blocked" },
          maxLifetimeMs: 10_000, provisionTimeoutMs: 2_000,
          resources: { cpu: 1, memoryMb: 512, diskMb: 1_024 },
          metadata: {}, idempotencyKey: "late-create", signal: controller.signal,
        });
    await admission;
    const reason = new Error("cancel the caller");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    resolveBox(box);
    await setImmediate();
    expect(deleted).toHaveBeenCalledTimes(outcome === "created" ? 1 : 0);
    if (outcome !== "created") expect(reason).toHaveProperty("cleanupHandle", box);
  });
});
