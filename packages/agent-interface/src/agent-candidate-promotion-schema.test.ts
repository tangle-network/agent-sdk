import { describe, expect, it } from "vitest";
import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";
import { agentImprovementActivationSchema } from "./agent-candidate-promotion-schema.js";

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;

function activation() {
  const material = {
    kind: "agent-improvement-activation" as const,
    proposalDigest: sha("1"),
    reviewDigest: sha("2"),
    experimentDigest: sha("3"),
    candidateBundleDigest: sha("4"),
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
  };
  return { ...material, digest: canonicalCandidateDigest(material) };
}

describe("agentImprovementActivationSchema", () => {
  it("accepts one exact activation authority receipt", () => {
    expect(agentImprovementActivationSchema.parse(activation())).toEqual(activation());
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
