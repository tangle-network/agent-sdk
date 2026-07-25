import { describe, expect, it } from "vitest";
import {
  certifiedCapabilitySchema,
  certifiedProfileSchema,
  parseCertifiedProfile,
} from "./certified-profile.js";

const provenance = {
  contentHash: "sha256:abc",
  version: 3,
  lift: "+3.1pp",
  promotedAt: "2026-07-25T20:00:00.000Z",
};

const profile = {
  target: "support-agent",
  generatedAt: "2026-07-25T20:01:00.000Z",
  capabilities: [
    {
      id: "prompt",
      iface: {
        surface: "context",
        kind: "prompt",
        name: "system prompt",
      },
      binding: {
        kind: "inline",
        content: "Verify the invoice before issuing a refund.",
      },
      provenance: { ...provenance, sourcePath: null },
    },
    {
      id: "refund-tool",
      iface: {
        surface: "tool",
        name: "issue_refund",
        parameters: {
          type: "object",
          properties: { invoiceId: { type: "string" } },
        },
      },
      binding: {
        kind: "http",
        url: "https://tools.example.com/refund",
        auth: { mode: "tangle-key" },
      },
      provenance: { ...provenance, sourcePath: "tools/refund.json" },
    },
  ],
  agentProfileDiffs: [],
  agentProfile: null,
};

describe("certifiedProfileSchema", () => {
  it("parses the current capability-only profile", () => {
    expect(parseCertifiedProfile(profile)).toEqual(profile);
  });

  it("rejects the removed promptSurface and artifacts representation", () => {
    expect(() =>
      parseCertifiedProfile({
        ...profile,
        promptSurface: null,
        artifacts: {},
      }),
    ).toThrow();
  });

  it("rejects unsupported interface and binding combinations", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[0],
        binding: {
          kind: "http",
          url: "https://tools.example.com/context",
        },
      }),
    ).toThrow(/context capabilities do not support http bindings/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[1],
        binding: { kind: "inline", content: "static response" },
      }),
    ).toThrow(/tool capabilities do not support inline bindings/);
  });

  it("rejects blank delivered context", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[0],
        binding: { kind: "inline", content: "   " },
      }),
    ).toThrow(/context capability content cannot be blank/);
  });

  it("rejects duplicate capability ids", () => {
    expect(() =>
      certifiedProfileSchema.parse({
        ...profile,
        capabilities: [
          profile.capabilities[0],
          profile.capabilities[0],
        ],
      }),
    ).toThrow(/duplicate capability id/);
  });

  it("requires profile diffs and the composed profile to agree", () => {
    expect(() =>
      certifiedProfileSchema.parse({
        ...profile,
        agentProfile: { name: "support-agent" },
      }),
    ).toThrow(
      /agentProfile must be null exactly when agentProfileDiffs is empty/,
    );
  });

  it("accepts a composed profile when a certified diff is present", () => {
    expect(
      certifiedProfileSchema.parse({
        ...profile,
        agentProfileDiffs: [
          {
            diff: {
              kind: "agent-profile-diff",
              set: { prompt: { instructions: ["Ask for the invoice id."] } },
            },
            provenance,
          },
        ],
        agentProfile: {
          name: "support-agent",
          prompt: { instructions: ["Ask for the invoice id."] },
        },
      }).agentProfile,
    ).toEqual({
      name: "support-agent",
      prompt: { instructions: ["Ask for the invoice id."] },
    });
  });
});
