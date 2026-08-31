/** Shared types and interfaces for SDK provider adapters. */

export * from "./parts.js";
export * from "./stream-events.js";
export * from "./execution-types.js";
export * from "./backend-message.js";
export * from "./provider-config.js";
export * from "./host-services.js";
export * from "./mcp.js";
export * from "./provider-adapter.js";

export type * from "./environment-provider.js";
export {
  AgentEnvironmentCapabilitiesSchema,
  AgentNativeContextContinuationAdmissionSchema,
  AgentNativeContextContinuationResultSchema,
  AgentTurnInputSchema,
  AgentTurnResultSchema,
  agentEnvironmentCreateInputDigest,
  agentNativeContextContinuationAdmissionMatchesRequest,
  agentNativeContextContinuationResultMatchesRequest,
  AccountUsageSchema,
  AgentEnvironmentObservationSchema,
  AgentEnvironmentStatusSchema,
  ComputeBillingSchema,
  EnvironmentLifecycleSchema,
  ModelUsageSchema,
  ObservationProvenanceSchema,
  ObservationStateSchema,
  PlacementDescriptorSchema,
  ProviderIdentitySchema,
  ResourceProfileSchema,
  ResourceUseSampleSchema,
  SafeEndpointSchema,
  agentEnvironmentObservationIdentityMatches,
  assertObservationCredentialFree,
  observationContainsCredential,
  observationOf,
  AgentInteractiveSessionAttachSchema,
  AgentInteractiveSessionControlClaimAcknowledgementSchema,
  AgentInteractiveSessionControlClaimRequestSchema,
  AgentInteractiveSessionControlClaimSchema,
  AgentInteractiveSessionPromptAcknowledgementSchema,
  AgentInteractiveSessionPromptCommandSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStartSchema,
  AgentInteractiveSessionStopAcknowledgementSchema,
  AgentInteractiveSessionStopCommandSchema,
  AgentInteractiveSessionStatusSchema,
  agentInteractiveSessionControlClaimAcknowledgementMatchesRequest,
  agentInteractiveSessionControlClaimRequestDigest,
  agentInteractiveSessionControlClaimMatchesRef,
  agentInteractiveSessionControlClaimIsNewer,
  agentInteractiveSessionPromptAcknowledgementMatchesCommand,
  agentInteractiveSessionPromptRequestDigest,
  agentInteractiveSessionStopAcknowledgementMatchesCommand,
  agentInteractiveSessionStopRequestDigest,
  agentInteractiveSessionRequestDigest,
  agentInteractiveSessionRefMatchesStart,
  agentInteractiveSessionRunRef,
  agentInteractiveSessionStatusMatchesRef,
  exactAgentInteractiveSessionStart,
  AgentEnvironmentCreationSchema,
  createAgentEnvironmentWithIdempotency,
  replayedAgentEnvironmentView,
  canonicalWorkspaceCwd,
  MAX_WORKSPACE_CWD_LENGTH,
  workspaceCwdSchema,
  workspaceCwdPathForBase,
  WorkspaceRequestSchema,
  TerminalAttachRequestSchema,
  TerminalAttachResultSchema,
  TerminalDetachAckSchema,
  TerminalInputSchema,
  TerminalOutputEventSchema,
  TerminalReplayWindowSchema,
  TerminalResizeSchema,
  TerminalSessionRefSchema,
  terminalAttachResultMatchesRequest,
  terminalSessionUsable,
} from "./environment-provider.js";
export * from "./plan.js";
export * from "./runtime-control.js";
export * from "./portable-context.js";
export * from "./workspace-branching.js";
export * from "./interaction.js";
export * from "./agent-candidate.js";
export * from "./agent-candidate-schema.js";
export type { Sha256Digest } from "./agent-candidate.js";
export {
  canonicalCandidateBytes,
  canonicalCandidateDigest,
  canonicalCandidateJson,
  sha256Bytes,
  sha256DigestSchema,
  sha256Utf8,
} from "./agent-candidate-schema-common.js";
export { numbersApproximatelyEqual } from "./number-validation.js";
export * from "./agent-candidate-promotion-schema.js";
export { agentCandidateEvaluationPolicySchema } from "./agent-improvement-measurement-schema.js";
export * from "./agent-improvement-source.js";
export * from "./agent-profile-improvement.js";
export * from "./agent-profile-improvement-schema.js";
export * from "./agent-execution-limits.js";
export * from "./agent-profile.js";
export * from "./agent-instance.js";
export * from "./agent-profile-snapshot.js";
export * from "./agent-profile-activation.js";
export * from "./agent-profile-materialization.js";
export * from "./agent-execution-preparation.js";
export * from "./agent-workspace-lease.js";
export * from "./certified-context.js";
export * from "./deep-freeze.js";
export * from "./profile-diff.js";
export * from "./harness.js";
export * from "./harness-capabilities.js";
export * from "./profile-schema.js";
export * from "./profile-security.js";
export * from "./sandbox-size.js";
export {
  CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH,
} from "./contract-limits.js";
