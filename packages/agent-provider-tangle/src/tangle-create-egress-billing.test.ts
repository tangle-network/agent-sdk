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

function capturingProvider() {
  const creates: CreateSandboxOptions[] = [];
  const box: SandboxInstanceLike = {
    id: "sbx-create",
    status: "running",
    async *streamPrompt() {},
    delete: async () => undefined,
  };
  const provider = createTangleProvider({
    client: {
      create: async (options?: CreateSandboxOptions) => {
        creates.push(options ?? {});
        return box;
      },
    },
  });
  return { provider, creates };
}

describe("Tangle create input: egress policy and billing owner", () => {
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
    ).rejects.toThrow();
    expect(creates).toHaveLength(0);
  });

  it("refuses an unknown mode and an empty billing owner", async () => {
    const { provider, creates } = capturingProvider();

    await expect(
      provider.create({
        profile: { name: "worker" },
        egress: { mode: "permissive" } as never,
      }),
    ).rejects.toThrow();
    await expect(
      provider.create({ profile: { name: "worker" }, billingOwner: "" }),
    ).rejects.toThrow("Tangle billing owner is invalid");
    expect(creates).toHaveLength(0);
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
    });
  });
});
