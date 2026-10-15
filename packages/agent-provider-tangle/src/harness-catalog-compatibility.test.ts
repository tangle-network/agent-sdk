import { describe, expect, it } from "vitest";
import { recognizedCaptureHarnesses } from "./capture-harness-list.js";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";
import { assertNativeCaptureHarness, nativeCaptureHarnesses } from "./tangle-native-capture-proof.js";
import type { SandboxRuntimeCapabilityDocument } from "./tangle-types.js";

const document: SandboxRuntimeCapabilityDocument = {
  schema: 1,
  nativeSessionCaptureVersion: 2,
  nativeSessionCaptureHarnesses: ["opencode", "future-runner-v2"],
};

// The SDK client boundary supplies a container proof; no native capture or live
// model execution is claimed by this deterministic provider-contract test.
const proof = {
  hostId: "host-catalog-test",
  containerId: "a".repeat(64),
  imageId: `sha256:${"b".repeat(64)}`,
  bundleRevision: "c".repeat(40),
  bundleChecksum: `sha256:${"d".repeat(64)}`,
};

function box(capabilities: SandboxRuntimeCapabilityDocument) {
  let prompts = 0;
  let deletes = 0;
  const instance: SandboxInstanceLike = {
    id: "sbx-catalog-test",
    status: "running",
    async *streamPrompt() { prompts++; },
    async delete() { deletes++; },
    async capabilities() { return capabilities; },
    captureProof: () => proof,
    createReceipt: () => ({ outcome: "created", idempotencyKeyApplied: true, captureProof: proof }),
  };
  return { instance, prompts: () => prompts, deletes: () => deletes };
}

describe("harness catalog version independence", () => {
  it("admits a known selected harness through the provider when a newer server advertises another", async () => {
    const peer = box(document);
    const provider = createTangleProvider({
      requireNativeSessionCapture: true,
      client: { create: async () => peer.instance },
    });
    const environment = await provider.create({ profile: { name: "worker", harness: "opencode" } });
    for await (const _ of environment.stream({ prompt: "work" })) {}
    expect(peer.prompts()).toBe(1);
    expect(peer.deletes()).toBe(0);
  });

  it("does not turn an unknown advertised identity into executable support", () => {
    expect(nativeCaptureHarnesses(document.nativeSessionCaptureHarnesses)).toEqual(["opencode"]);
    expect(() => assertNativeCaptureHarness(document, "future-runner-v2"))
      .toThrow("has not proven native session capture for harness");
    expect(() => assertNativeCaptureHarness(document, "codex"))
      .toThrow("has not proven native session capture for harness");
  });

  it("cleans up its new container before any prompt when only unknown identities are advertised", async () => {
    const peer = box({ ...document, nativeSessionCaptureHarnesses: ["future-runner-v2"] });
    const provider = createTangleProvider({
      requireNativeSessionCapture: true,
      client: { create: async () => peer.instance },
    });
    await expect(provider.create({ profile: { name: "worker", harness: "opencode" } }))
      .rejects.toThrow("native session capture");
    expect(peer.prompts()).toBe(0);
    expect(peer.deletes()).toBe(1);
  });

  it.each([
    undefined, null, {}, "opencode", [null], [42], [""], [" opencode"],
    ["opencode\n"], ["opencode\u0000"], ["x".repeat(129)],
    ["opencode", "opencode"], ["opencode", "future", "future"], new Array(1),
    Array.from({ length: 257 }, (_, index) => `future-${index}`),
  ])("rejects malformed and duplicate entries rather than ignoring them: %j", (raw) => {
    expect(() => nativeCaptureHarnesses(raw)).toThrow("valid harness list");
  });

  it("bounds the list independently of the client's enum size", () => {
    const raw = [...Array.from({ length: 255 }, (_, index) => `future-${index}`), "opencode"];
    expect(nativeCaptureHarnesses(raw)).toEqual(["opencode"]);
  });

  it("continues to recognize the remaining IDs when a reader drops support for one", () => {
    expect(recognizedCaptureHarnesses(["pi", "opencode"], ["opencode"] as const)).toEqual(["opencode"]);
    expect(recognizedCaptureHarnesses(["pi"], ["opencode"] as const)).toEqual([]);
  });

  it("returns an immutable snapshot without changing a caller-owned list", () => {
    const raw = Object.freeze(["opencode", "future"]);
    const parsed = nativeCaptureHarnesses(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(raw).toEqual(["opencode", "future"]);
  });
});
