import { describe, expect, it } from "vitest";
import type {
  AgentProfile,
  AgentWorkspaceExecutionBoundLeaseRecord,
  AgentWorkspaceSealedLeaseRecord,
} from "./index.js";
import {
  buildAgentExecutionPreparationReceipt,
  validateAgentExecutionPreparationReceipt,
} from "./index.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation-profile.js";
import { AgentProfileJsonError } from "./agent-profile-safe-json.js";
import { snapshotAgentProfile } from "./agent-profile-snapshot.js";

const digest = `sha256:${"1".repeat(64)}` as `sha256:${string}`;

describe("execution preparation JSON bounds", () => {
  it("returns controlled errors at depths 1000, 3000, and 6000", () => {
    for (const depth of [1_000, 3_000, 6_000]) {
      const profile = deepProfile(depth);
      expect(() => canonicalProfile(profile), `digest depth ${depth}`).toThrow(
        AgentProfileJsonError,
      );
      expect(() => snapshotProfile(profile), `snapshot depth ${depth}`).toThrow(
        AgentProfileJsonError,
      );
      expect(() => buildReceipt(profile), `receipt build depth ${depth}`).toThrow(
        AgentProfileJsonError,
      );

      const validation = validateAgentExecutionPreparationReceipt({
        receipt: {},
        requestDigest: digest,
        authoredProfile: profile,
        effectiveProfile: profile,
        executionPlanDigest: digest,
        profileActivation: { digest },
        workspaceLease: {} as AgentWorkspaceExecutionBoundLeaseRecord,
      });
      expect(validation.ok, `receipt validation depth ${depth}`).toBe(false);
      expect(validation.issues[0]?.code).toBe("invalid-receipt");
    }
  });
});

function deepProfile(depth: number): AgentProfile {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return { metadata: { nested: value } };
}

function canonicalProfile(profile: AgentProfile): string {
  return canonicalAgentProfileDigest(profile);
}

function snapshotProfile(profile: AgentProfile): AgentProfile {
  return snapshotAgentProfile(profile);
}

function buildReceipt(profile: AgentProfile): unknown {
  return buildAgentExecutionPreparationReceipt({
    preparationId: "preparation",
    requestDigest: digest,
    authoredProfile: profile,
    effectiveProfile: profile,
    backend: "cli-bridge",
    harness: "codex",
    harnessVersion: "1.0.0",
    resolvedModel: { requested: "model", resolved: "model" },
    workspaceLease: {} as AgentWorkspaceSealedLeaseRecord,
    profileActivation: { digest },
    axisResults: [],
    executionPlanDigest: digest,
    materializer: { name: "materializer", version: "1.0.0" },
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });
}
