import {
  agentInteractiveSessionRunRef,
  buildAgentExecutionPreparationReceipt,
  buildAgentWorkspaceLeaseRecord,
  canonicalAgentProfileDigest,
  profileMaterializationRequests,
  type AgentExecutionPreparationReceipt,
  type AgentProfile,
} from "@tangle-network/agent-interface";

export const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;
export const startedAt = "2026-08-16T00:00:00.000Z";
export const endedAt = "2026-08-16T00:05:00.000Z";
export const profile: AgentProfile = {
  name: "braid-test-agent",
  harness: "pi",
  model: {
    provider: "tangle-router",
    default: "zai/glm-5.2",
    reasoningEffort: "high",
  },
  prompt: { instructions: ["Fix the failing test."] },
};
export const profileDigest = canonicalAgentProfileDigest(profile);
export const startInput = {
  profile,
  requestedProfileDigest: profileDigest,
  initialPrompt: "Find and fix the failing test.",
  cwd: "/workspace",
  cols: 120,
  rows: 40,
} as const;
export const coordinates = {
  provider: "tangle-sandbox",
  environmentId: "sandbox-1",
  sessionId: "session-1",
  executionId: "execution-1",
};
export const interactiveRun = agentInteractiveSessionRunRef(coordinates, startInput);
export const preparationReceipt = preparationReceiptFor(interactiveRun.requestDigest, profile);
export const incarnationId = "interactive-incarnation-1";

function preparationReceiptFor(
  requestDigest: `sha256:${string}`,
  authoredProfile: AgentProfile
): AgentExecutionPreparationReceipt {
  const sourceSnapshotPolicy = {
    kind: "provider-declared" as const,
    name: "tangle-sandbox/workspace",
    version: 1,
    digest: sha("7"),
  };
  const workspaceLease = buildAgentWorkspaceLeaseRecord({
    kind: "agent-workspace-lease" as const,
    schemaVersion: 1 as const,
    phase: "workspace-sealed" as const,
    leaseId: "sandbox-lease-1",
    ownerId: "tangle-sandbox",
    workspace: {
      provider: "tangle-sandbox",
      root: "/workspace",
      identityDigest: sha("2"),
    },
    isolation: "per-run" as const,
    sourceSnapshotDigest: sha("8"),
    sourceSnapshotPolicy,
    preparedWorkspaceDigest: sha("9"),
    profileActivationDigest: sha("3"),
    createdAtMs: 100,
    updatedAtMs: 200,
    expiresAtMs: 3_000,
    cleanupAttempts: 0,
  });
  const axisResults = profileMaterializationRequests(authoredProfile).map(
    ({ axis, path }) => ({
      axis,
      path,
      disposition: "behavior" as const,
      owner: "executor" as const,
      mechanism: "sandbox-profile-materializer",
    })
  );
  return buildAgentExecutionPreparationReceipt({
    preparationId: "sandbox-preparation-1",
    requestDigest,
    authoredProfile,
    effectiveProfile: authoredProfile,
    backend: "tangle-router",
    harness: "pi",
    harnessVersion: "pi-1",
    resolvedModel: {
      requested: "zai/glm-5.2",
      resolved: "zai/glm-5.2",
      provider: "tangle-router",
      reasoningEffort: {
        requested: "high",
        resolved: "high",
        fidelity: "exact",
      },
    },
    workspaceLease,
    profileActivation: { digest: sha("3") },
    axisResults,
    executionPlanDigest: sha("4"),
    materializer: { name: "agent-profile-materialize", version: "0.15.3" },
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });
}
