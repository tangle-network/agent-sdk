import type { Sha256Digest } from "./agent-candidate.js";
import type { AgentProfile } from "./agent-profile.js";
import type { AgentProfileActivationEvidence } from "./agent-profile-activation.js";
import type {
  AgentProfileMaterializationAxis,
} from "./agent-profile-materialization.js";
import type { HarnessType } from "./harness.js";
import type {
  AgentWorkspaceExecutionBoundLeaseRecord,
  AgentWorkspaceSealedLeaseRecord,
  AgentWorkspaceSourceSnapshotPolicy,
} from "./agent-workspace-lease.js";

export type AgentExecutionPreparationDisposition =
  | "behavior"
  | "control"
  | "overridden"
  | "unsupported";

export type AgentExecutionPreparationOwner = "runtime" | "executor";

/** One exact profile path and how the prepared execution will handle it. */
export interface AgentExecutionPreparationAxisResult {
  axis: AgentProfileMaterializationAxis;
  disposition: AgentExecutionPreparationDisposition;
  owner: AgentExecutionPreparationOwner;
  /** Public mechanism identifier; launch arguments are structurally refused. */
  mechanism: string;
  evidenceDigest?: Sha256Digest;
  /** RFC 6901 JSON Pointer. Required when one axis has multiple requested paths. */
  path?: string;
  /** Sanitized public diagnostic prose for an override or unsupported path. */
  reason?: string;
}

export interface AgentExecutionPreparationReasoningEffort {
  requested: import("./agent-profile.js").ReasoningEffort;
  resolved?: import("./agent-profile.js").ReasoningEffort;
  fidelity: "exact" | "clamped" | "unsupported";
}

export interface AgentExecutionPreparationResolvedModel {
  /** Exact effective profile request; an explicit empty hint remains empty. */
  requested: string;
  /** Concrete non-empty model selected for execution. */
  resolved: string;
  /** Exact effective provider hint when present, including an explicit empty hint. */
  provider?: string;
  reasoningEffort?: AgentExecutionPreparationReasoningEffort;
}

export interface AgentExecutionPreparationWorkspace {
  /** Public, non-secret lifecycle identity for the workspace lease. */
  leaseId: string;
  /** Provider that owns the private prepared workspace capability. */
  provider: string;
  /** Digest of the immutable allocation tuple, not filesystem contents. */
  identityDigest: Sha256Digest;
  isolation: "per-run" | "shared";
  /** Canonical source snapshot before the isolated copy is prepared. */
  sourceSnapshotDigest: Sha256Digest;
  /** Public identity of the exact snapshot/canonicalization policy. */
  sourceSnapshotPolicy: AgentWorkspaceSourceSnapshotPolicy;
  /** Canonical actual workspace after profile activation and before compute. */
  preparedWorkspaceDigest: Sha256Digest;
  profileActivationDigest: Sha256Digest;
}

export interface AgentExecutionPreparationMaterializer {
  name: string;
  version: string;
}

export interface AgentExecutionPreparationReceipt {
  kind: "agent-execution-preparation";
  schemaVersion: 1;
  preparationId: string;
  requestDigest: Sha256Digest;
  /** Digest of the authored profile recorded by this preparation. */
  authoredProfileDigest: Sha256Digest;
  /** Digest of the effective profile recorded after per-run overrides. */
  effectiveProfileDigest: Sha256Digest;
  backend: string;
  harness: HarnessType;
  harnessVersion: string;
  resolvedModel: AgentExecutionPreparationResolvedModel;
  workspace: AgentExecutionPreparationWorkspace;
  axisResults: AgentExecutionPreparationAxisResult[];
  /** Caller-supplied digest of public decisions and secret-reference identities. */
  executionPlanDigest: Sha256Digest;
  materializer: AgentExecutionPreparationMaterializer;
  expiresAtMs: number;
  digest: Sha256Digest;
}

export interface BuildAgentExecutionPreparationReceiptInput {
  preparationId: string;
  requestDigest: Sha256Digest;
  authoredProfile: AgentProfile;
  effectiveProfile: AgentProfile;
  backend: string;
  harness: HarnessType;
  harnessVersion: string;
  resolvedModel: AgentExecutionPreparationResolvedModel;
  /** Exact sealed public lease projection; owner authorization remains private. */
  workspaceLease: AgentWorkspaceSealedLeaseRecord;
  profileActivation: Pick<AgentProfileActivationEvidence, "digest">;
  axisResults: readonly AgentExecutionPreparationAxisResult[];
  /** Must digest public decisions and reference identities, not resolved values. */
  executionPlanDigest: Sha256Digest;
  materializer: AgentExecutionPreparationMaterializer;
  expiresAtMs: number;
  /** Clock used only to refuse already-expired preparations. */
  nowMs?: number;
}

export interface ValidateAgentExecutionPreparationReceiptOptions {
  receipt: unknown;
  requestDigest: Sha256Digest;
  authoredProfile: AgentProfile;
  effectiveProfile: AgentProfile;
  /** Expected public-plan identity; callers must not derive it from secret values. */
  executionPlanDigest: Sha256Digest;
  profileActivation: Pick<AgentProfileActivationEvidence, "digest">;
  /** Bound lease closes the receipt-to-workspace link before compute begins. */
  workspaceLease: AgentWorkspaceExecutionBoundLeaseRecord;
  nowMs?: number;
  preparationId?: string;
  backend?: string;
  harness?: HarnessType;
  harnessVersion?: string;
}

export type AgentExecutionPreparationValidationIssueCode =
  | "invalid-receipt"
  | "invalid-profile"
  | "invalid-workspace-lease"
  | "workspace-not-execution-bound"
  | "execution-binding-mismatch"
  | "digest-mismatch"
  | "expectation-mismatch"
  | "expired"
  | "missing-coverage"
  | "ambiguous-coverage"
  | "duplicate-coverage"
  | "conflicting-coverage"
  | "unrequested-coverage"
  | "invalid-disposition"
  | "strict-unsupported"
  | "model-fidelity";

export interface AgentExecutionPreparationValidationIssue {
  code: AgentExecutionPreparationValidationIssueCode;
  message: string;
  axis?: AgentProfileMaterializationAxis;
  path?: string;
}

export type AgentExecutionPreparationValidationResult =
  | {
      ok: true;
      receipt: AgentExecutionPreparationReceipt;
      issues: [];
    }
  | {
      ok: false;
      issues: AgentExecutionPreparationValidationIssue[];
    };
