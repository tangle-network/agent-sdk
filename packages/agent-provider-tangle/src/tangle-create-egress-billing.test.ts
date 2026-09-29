/**
 * Egress policy and billing owner on the generic create input.
 *
 * Both are required to create a Tangle box: creation needs a billing owner plus a trusted
 * delegate key, and the platform's default strict allowlist drops a model provider host, which
 * surfaces inside the box as an authorization error that names no policy. Before these fields
 * existed on `CreateAgentEnvironmentInput`, the only way to send them was a private
 * `mapCreateInput` or a wrapper around the `SandboxClient` — a wrapper the runtime cannot see, so
 * its create options are absent from every record the run produces.
 *
 * These tests call the provider with the neutral input alone: no mapper, no client wrapper.
 */

import type { CreateSandboxOptions } from "@tangle-network/sandbox";
import { describe, expect, it } from "vitest";
import {
  createTangleProvider,
  defaultTangleSandboxCapabilities,
  type SandboxInstanceLike,
} from "./index.js";

const CAPTURE_PROOF = {
  hostId: "host-1",
  containerId: "a".repeat(64),
  imageId: `sha256:${"b".repeat(64)}`,
  bundleRevision: "c".repeat(40),
  bundleChecksum: `sha256:${"d".repeat(64)}`,
};

function capturingProvider(requireNativeSessionCapture = false) {
  const creates: CreateSandboxOptions[] = [];
  const box: SandboxInstanceLike = {
    id: "sbx-create",
    status: "running",
    async *streamPrompt() {},
    delete: async () => undefined,
    captureProof: () => CAPTURE_PROOF,
    createReceipt: () => ({ outcome: "created", idempotencyKeyApplied: true, captureProof: CAPTURE_PROOF }),
  };
  const provider = createTangleProvider({
    requireNativeSessionCapture,
    client: {
      evidenceCapabilities: async () => ({ nativeSessionCaptureV1: false, nativeSessionCaptureHarnesses: ["opencode"] }),
      create: async (options?: CreateSandboxOptions) => {
        creates.push(options ?? {});
        return box;
      },
    },
  });
  return { provider, creates };
}

describe("Tangle create input: egress policy and billing owner", () => {
  it("requires proven native capture on every create when configured", async () => {
    const { provider, creates } = capturingProvider(true);
    await provider.create({ profile: { name: "first" } });
    await provider.create({ profile: { name: "second" } });
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatchObject({ requireNativeSessionCapture: true });
    expect(creates[1]).toMatchObject({ requireNativeSessionCapture: true });
  });

  it("keeps the requirement when a custom mapper selects the create options", async () => {
    const creates: CreateSandboxOptions[] = [];
    const provider = createTangleProvider({
      requireNativeSessionCapture: true,
      mapCreateInput: () => ({ backend: { type: "opencode" } }),
      client: {
        evidenceCapabilities: async () => ({ nativeSessionCaptureV1: false, nativeSessionCaptureHarnesses: ["opencode"] }),
        create: async (options) => {
          creates.push(options ?? {});
          return { id: "sbx-mapped", status: "running", async *streamPrompt() {}, delete: async () => undefined,
            captureProof: () => CAPTURE_PROOF,
            createReceipt: () => ({ outcome: "created", idempotencyKeyApplied: true, captureProof: CAPTURE_PROOF }) };
        },
      },
    });
    await provider.create({ profile: { name: "worker" } });
    expect(creates[0]).toMatchObject({ requireNativeSessionCapture: true });
  });

  it("refuses an unproved deployment before Sandbox.create", async () => {
    let created = false;
    const provider = createTangleProvider({
      requireNativeSessionCapture: true,
      client: { evidenceCapabilities: async () => ({ nativeSessionCaptureV1: false }),
        create: async () => { created = true; throw new Error("unexpected create"); } },
    });
    await expect(provider.create({ profile: { name: "worker" } })).rejects.toThrow(/has not proven native session capture/);
    expect(created).toBe(false);
  });

  it.each([
    { label: "unlisted exact harness", profile: { name: "worker", harness: "claude-code" as const }, backend: "claude-code" as const, listed: ["opencode" as const] },
    { label: "mapper changed the profile harness", profile: { name: "worker", harness: "claude-code" as const }, backend: "opencode" as const, listed: ["opencode" as const] },
    { label: "missing explicit backend", profile: { name: "worker" }, backend: undefined, listed: ["opencode" as const] },
  ])("refuses $label before create despite the global flag", async ({ profile, backend, listed }) => {
    let creates = 0;
    const provider = createTangleProvider({
      requireNativeSessionCapture: true,
      mapCreateInput: () => backend === undefined ? {} : { backend: { type: backend } },
      client: {
        evidenceCapabilities: async () => ({ nativeSessionCaptureV1: true, nativeSessionCaptureHarnesses: listed }),
        create: async () => { creates++; throw new Error("unexpected create"); },
      },
    });
    await expect(provider.create({ profile })).rejects.toThrow(/harness|explicit selected backend/);
    expect(creates).toBe(0);
  });

  it.each([undefined, [], ["opencode", "opencode"], ["future-unregistered"]])("refuses an invalid or empty admission list %j before create", async (listed) => {
    let creates = 0;
    const provider = createTangleProvider({
      requireNativeSessionCapture: true,
      client: {
        evidenceCapabilities: async () => ({
          nativeSessionCaptureV1: true,
          nativeSessionCaptureHarnesses: listed as never,
        }),
        create: async () => { creates++; throw new Error("unexpected create"); },
      },
    });
    await expect(provider.create({ profile: { name: "worker" } })).rejects.toThrow(/has not proven native session capture/);
    expect(creates).toBe(0);
  });

  it("cleans up a created box when the current capture proof is missing", async () => {
    let deleted = false;
    const provider = createTangleProvider({
      requireNativeSessionCapture: true,
      client: { evidenceCapabilities: async () => ({ nativeSessionCaptureV1: false, nativeSessionCaptureHarnesses: ["opencode"] }),
        create: async () => ({ id: "sbx-unproved", status: "running",
        async *streamPrompt() {}, delete: async () => { deleted = true; } }) },
    });
    await expect(provider.create({ profile: { name: "worker" } })).rejects.toThrow(/no verified current container proof/);
    expect(deleted).toBe(true);
  });

  it("rejects resume of an existing box with no current capture proof", async () => {
    const provider = createTangleProvider({
      requireNativeSessionCapture: true,
      client: {
        create: async () => { throw new Error("not called"); },
        get: async () => ({ id: "sbx-unproved", status: "running", async *streamPrompt() {} }),
      },
    });
    await expect(provider.get?.("sbx-unproved")).rejects.toThrow(/no verified current container proof/);
  });

  it("does not require native capture for ordinary creates", async () => {
    const { provider, creates } = capturingProvider();
    await provider.create({ profile: { name: "worker" } });
    expect(creates[0]).not.toHaveProperty("requireNativeSessionCapture");
  });

  it("carries both fields to Sandbox.create with no mapper and no client wrapper", async () => {
    const { provider, creates } = capturingProvider();

    await provider.create({
      profile: { name: "worker" },
      egress: { mode: "open" },
      billingOwner: "usr_funded_account",
    });

    expect(creates).toHaveLength(1);
    expect(creates[0]?.egressPolicy).toEqual({ mode: "open" });
    expect(creates[0]?.billingOwnerId).toBe("usr_funded_account");
  });

  it("projects blocked mode without inventing a domain list", async () => {
    const { provider, creates } = capturingProvider();

    await provider.create({ profile: { name: "worker" }, egress: { mode: "blocked" } });

    expect(creates[0]?.egressPolicy).toEqual({ mode: "blocked" });
  });

  it("copies the allowlist, so a caller's later mutation cannot change the sent policy", async () => {
    const { provider, creates } = capturingProvider();
    const allowDomains = ["api.example.com"];

    await provider.create({
      profile: { name: "worker" },
      egress: { mode: "strict", allowDomains },
    });
    allowDomains.push("evil.example.com");

    expect(creates[0]?.egressPolicy).toEqual({
      mode: "strict",
      allowDomains: ["api.example.com"],
    });
  });

  it("carries a strict allowlist and opts into no implicit domains", async () => {
    const { provider, creates } = capturingProvider();

    await provider.create({
      profile: { name: "worker" },
      egress: { mode: "strict", allowDomains: ["api.example.com"] },
    });

    expect(creates[0]?.egressPolicy).toEqual({
      mode: "strict",
      allowDomains: ["api.example.com"],
    });
    // Sandbox defaults `includeImplicitDomains` to false. Setting it would silently widen a
    // strict policy to about forty hosts, including public source hosts.
    expect(creates[0]?.egressPolicy).not.toHaveProperty("includeImplicitDomains");
  });

  it("refuses a domain list outside strict mode instead of sending an ignored one", async () => {
    const { provider, creates } = capturingProvider();

    await expect(
      provider.create({
        profile: { name: "worker" },
        egress: { mode: "open", allowDomains: ["api.example.com"] } as never,
      }),
    ).rejects.toThrow(/allowDomains|unrecognized|invalid/i);
    expect(creates).toHaveLength(0);
  });

  it("refuses a domain that matches no host", async () => {
    const { provider, creates } = capturingProvider();

    await expect(
      provider.create({
        profile: { name: "worker" },
        egress: { mode: "strict", allowDomains: ["  api.example.com  "] },
      }),
    ).rejects.toThrow(/whitespace|invalid|too_big|identifier/i);
    expect(creates).toHaveLength(0);
  });

  it("refuses an unknown mode and an empty billing owner", async () => {
    const { provider, creates } = capturingProvider();

    await expect(
      provider.create({
        profile: { name: "worker" },
        egress: { mode: "permissive" } as never,
      }),
    ).rejects.toThrow(/invalid|union|mode/i);
    await expect(
      provider.create({ profile: { name: "worker" }, billingOwner: "" }),
    ).rejects.toThrow("Tangle billing owner is invalid");
    expect(creates).toHaveLength(0);
  });

  it("holds a custom mapCreateInput to the same shape the default path guarantees", async () => {
    const box: SandboxInstanceLike = {
      id: "sbx-mapped",
      status: "running",
      async *streamPrompt() {},
      delete: async () => undefined,
    };
    const mapped = (options: CreateSandboxOptions) =>
      createTangleProvider({
        client: { create: async () => box },
        mapCreateInput: () => options,
      }).create({ profile: { name: "worker" } });

    // A mapper that carries both fields correctly is accepted.
    await expect(
      mapped({
        backend: { type: "opencode", profile: { name: "worker" } },
        egressPolicy: { mode: "strict", allowDomains: ["api.example.com"] },
        billingOwnerId: "usr_funded_account",
      }),
    ).resolves.toBeDefined();

    // A mapper cannot smuggle past the gates the default path enforces.
    await expect(
      mapped({
        backend: { type: "opencode", profile: { name: "worker" } },
        egressPolicy: { mode: "open", allowDomains: ["api.example.com"] },
      }),
    ).rejects.toThrow("Tangle mapped egress policy allows domains only in strict mode");
    await expect(
      mapped({
        backend: { type: "opencode", profile: { name: "worker" } },
        egressPolicy: { mode: "strict", allowDomains: [123] as never },
      }),
    ).rejects.toThrow("Tangle mapped egress allowed domain is invalid");
    await expect(
      mapped({
        backend: { type: "opencode", profile: { name: "worker" } },
        billingOwnerId: "",
      }),
    ).rejects.toThrow("Tangle mapped billing owner is invalid");
  });

  it("still refuses an unknown create field", async () => {
    const { provider, creates } = capturingProvider();

    await expect(
      provider.create({
        profile: { name: "worker" },
        egressPolicy: { mode: "open" },
      } as never),
    ).rejects.toThrow("Tangle create input contains unsupported fields");
    expect(creates).toHaveLength(0);
  });

  it("declares what create accepts, so a caller reads the modes rather than guessing", () => {
    expect(defaultTangleSandboxCapabilities().create).toEqual({
      egress: ["open", "strict", "blocked"],
      billingOwner: true,
      runtimeAttachments: { mcp: true },
      workspaceCheckpoint: true,
    });
  });
});
