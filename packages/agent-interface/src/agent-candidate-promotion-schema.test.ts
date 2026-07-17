import { describe, expect, it } from "vitest";
import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";
import {
  agentImprovementActivationResultSchema,
  agentImprovementActivationSchema,
} from "./agent-candidate-promotion-schema.js";

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;

function activation() {
  const material = {
    kind: "agent-improvement-activation" as const,
    proposalDigest: sha("1"),
    reviewDigest: sha("2"),
    experimentDigest: sha("3"),
    candidateBundleDigest: sha("4"),
    intent: "activate-candidate" as const,
    targets: [
      {
        surface: "prompt" as const,
        identity: "agent-profile:support",
        expectedBaseDigest: sha("5"),
      },
    ] as const,
    fundingOwner: "tenant:test",
    authorizedBy: "policy:tenant-admin",
    authorizedAt: "2026-07-15T00:00:00.000Z",
    expiresAt: "2026-07-15T00:05:00.000Z",
  };
  return { ...material, digest: canonicalCandidateDigest(material) };
}

function activationResult(
  outcome: Record<string, unknown> = {
    status: "applied",
    transactionId: "profile-transaction:123",
    targets: [
      {
        surface: "prompt",
        identity: "agent-profile:support",
        beforeDigest: sha("5"),
        afterDigest: sha("6"),
      },
    ],
  },
) {
  const authority = activation();
  const material = {
    kind: "agent-improvement-activation-result" as const,
    idempotencyKey: authority.digest,
    attemptedAt: "2026-07-15T00:01:00.000Z",
    completedAt: "2026-07-15T00:01:01.000Z",
    outcome,
  };
  return { ...material, digest: canonicalCandidateDigest(material) };
}

describe("agentImprovementActivationSchema", () => {
  it("accepts one exact activation authority receipt", () => {
    expect(agentImprovementActivationSchema.parse(activation())).toEqual(activation());
  });

  it("accepts restore authority", () => {
    const { digest: _digest, ...authority } = activation();
    const material = { ...authority, intent: "restore-baseline" as const };
    const restore = { ...material, digest: canonicalCandidateDigest(material) };
    expect(agentImprovementActivationSchema.parse(restore)).toEqual(restore);
  });

  it("rejects duplicate surface identities", () => {
    const input = activation();
    expect(() =>
      agentImprovementActivationSchema.parse({
        ...input,
        targets: [...input.targets, input.targets[0]],
      }),
    ).toThrow(/unique by surface and identity/);
  });

  it("rejects authority that expires before it can be used", () => {
    const input = activation();
    expect(() =>
      agentImprovementActivationSchema.parse({
        ...input,
        expiresAt: input.authorizedAt,
      }),
    ).toThrow(/expiry must follow/);
  });

  it("rejects values outside canonical JSON", () => {
    expect(() =>
      agentImprovementActivationSchema.parse({
        ...activation(),
        targets: [
          {
            ...activation().targets[0],
            identity: undefined,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("agentImprovementActivationResultSchema", () => {
  it("accepts an applied transaction-wide result", () => {
    expect(agentImprovementActivationResultSchema.parse(activationResult())).toEqual(
      activationResult(),
    );
  });

  it.each([
    {
      status: "already-applied",
      targets: [
        { surface: "prompt", identity: "agent-profile:support", currentDigest: sha("6") },
      ],
    },
    {
      status: "conflict",
      targets: [
        { surface: "prompt", identity: "agent-profile:support", currentDigest: sha("9") },
      ],
    },
    { status: "expired" },
    { status: "unsupported", code: "TARGET_UNSUPPORTED", message: "No target adapter." },
    { status: "failed", code: "WRITE_REJECTED", message: "No state changed." },
    { status: "indeterminate", code: "CONNECTION_LOST", message: "Commit state is unknown." },
  ])("accepts the $status outcome", (outcome) => {
    const input = activationResult(outcome);
    expect(agentImprovementActivationResultSchema.parse(input)).toEqual(input);
  });

  it("rejects duplicate outcome targets", () => {
    const target = {
      surface: "prompt",
      identity: "agent-profile:support",
      currentDigest: sha("6"),
    };
    const input = activationResult({ status: "already-applied", targets: [target, target] });
    expect(() => agentImprovementActivationResultSchema.parse(input)).toThrow(
      /unique by surface and identity/,
    );
  });

  it("rejects duplicate applied targets", () => {
    const target = {
      surface: "prompt",
      identity: "agent-profile:support",
      beforeDigest: sha("5"),
      afterDigest: sha("6"),
    };
    const input = activationResult({
      status: "applied",
      transactionId: "profile-transaction:123",
      targets: [target, target],
    });
    expect(() => agentImprovementActivationResultSchema.parse(input)).toThrow(
      /unique by surface and identity/,
    );
  });

  it("rejects a completion before its attempt", () => {
    const input = activationResult();
    expect(() =>
      agentImprovementActivationResultSchema.parse({
        ...input,
        completedAt: "2026-07-15T00:00:59.999Z",
      }),
    ).toThrow(/cannot predate/);
  });
});
