import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileHookCommand,
  AgentProfileMcpServer,
  AgentProfileMode,
  AgentProfileModelHints,
  AgentProfileResourceRef,
  AgentProfileResources,
  AgentSubagentProfile,
  ReasoningEffort,
} from "./agent-profile.js";
import type { HarnessType } from "./harness.js";

/** Full SHA-256 digest with an explicit algorithm prefix. */
export type Sha256Digest = `sha256:${string}`;

/** RFC 8785 JSON Canonicalization Scheme followed by SHA-256. */
export type AgentCandidateDigestAlgorithm = "rfc8785-sha256";

export interface AgentCandidateS3Locator {
  kind: "s3";
  bucket: string;
  key: string;
  region?: string;
}

export interface AgentCandidateIpfsLocator {
  kind: "ipfs";
  cid: string;
  path?: string;
}

/** Closed locator set whose resolvers cannot choose arbitrary URL schemes. */
export type AgentCandidateArtifactLocator =
  | AgentCandidateS3Locator
  | AgentCandidateIpfsLocator;

/** Content-addressed artifact stored outside the candidate manifest. */
export interface AgentCandidateArtifactRef {
  locator: AgentCandidateArtifactLocator;
  sha256: Sha256Digest;
  byteLength: number;
}

/** Bytes embedded directly in a candidate manifest. */
export interface AgentCandidateEmbeddedArtifact {
  encoding: "base64";
  content: string;
  sha256: Sha256Digest;
  byteLength: number;
}

/** Captured bytes are either embedded for portable/local runs or stored by a closed resolver. */
export type AgentCandidateCapturedArtifact =
  | AgentCandidateArtifactRef
  | AgentCandidateEmbeddedArtifact;

/** A deliberately public value; producers remain responsible for secret scanning. */
export interface AgentCandidatePublicValue {
  kind: "public";
  value: string;
}

export type AgentCandidateConfigValue = AgentCandidatePublicValue;

export interface AgentCandidateGitHubRepository {
  kind: "github";
  owner: string;
  repo: string;
}

/** Text embedded in the bundle and checked again by the runtime verifier. */
export interface AgentCandidateInlineResource {
  kind: "inline";
  name: string;
  content: string;
  sha256: Sha256Digest;
  byteLength: number;
}

/** GitHub content pinned to a full Git object id and expected content digest. */
export interface AgentCandidateGitHubResource {
  kind: "github";
  repository: AgentCandidateGitHubRepository;
  path: string;
  commit: string;
  name?: string;
  sha256: Sha256Digest;
  byteLength: number;
}

export type AgentCandidateResourceRef =
  | AgentCandidateInlineResource
  | AgentCandidateGitHubResource;

export interface AgentCandidateFileMount
  extends Omit<AgentProfileFileMount, "resource"> {
  resource: AgentCandidateResourceRef;
}

export interface AgentCandidateResources
  extends Omit<
    AgentProfileResources,
    | "files"
    | "tools"
    | "skills"
    | "agents"
    | "commands"
    | "instructions"
    | "failOnError"
  > {
  files?: AgentCandidateFileMount[];
  tools?: AgentCandidateResourceRef[];
  skills?: AgentCandidateResourceRef[];
  agents?: AgentCandidateResourceRef[];
  commands?: AgentCandidateResourceRef[];
  instructions?: string | AgentCandidateResourceRef;
  failOnError: true;
}

export interface AgentCandidateMcpServer
  extends Omit<
    AgentProfileMcpServer,
    "transport" | "args" | "env" | "headers" | "url" | "metadata"
  > {
  transport?: "stdio";
  args?: AgentCandidateConfigValue[];
  env?: Record<string, AgentCandidateConfigValue>;
}

export type AgentCandidateModelHints = Omit<AgentProfileModelHints, "metadata">;
export type AgentCandidateSubagentProfile = Omit<
  AgentSubagentProfile,
  "metadata"
>;
export type AgentCandidateMode = Omit<AgentProfileMode, "metadata">;

export interface AgentCandidateHookCommand
  extends Omit<AgentProfileHookCommand, "command" | "env"> {
  executable: string;
  args?: AgentCandidateConfigValue[];
  env?: Record<string, AgentCandidateConfigValue>;
}

/**
 * Recursively strict, immutable form of AgentProfile used inside a candidate.
 * Mutable resource locators and plaintext credential-bearing config are replaced
 * by content-addressed resources and named secret references.
 */
export interface AgentCandidateProfile
  extends Omit<
    AgentProfile,
    | "model"
    | "mcp"
    | "connections"
    | "subagents"
    | "resources"
    | "hooks"
    | "modes"
    | "metadata"
    | "extensions"
  > {
  model?: AgentCandidateModelHints;
  mcp?: Record<string, AgentCandidateMcpServer>;
  subagents?: Record<string, AgentCandidateSubagentProfile>;
  resources?: AgentCandidateResources;
  hooks?: Record<string, AgentCandidateHookCommand[]>;
  modes?: Record<string, AgentCandidateMode>;
}

export interface AgentCandidateCodeDisabled {
  kind: "disabled";
  /** `control` marks a comparison arm; `not-applicable` disables only the code surface. */
  reason: "control" | "not-applicable";
}

/** A code proposer ran against this exact tree and returned no change. */
export interface AgentCandidateCodeNoOp {
  kind: "no-op";
  reason: "proposer-no-change";
  repository: AgentCandidateGitHubRepository;
  baseCommit: string;
  baseTree: string;
}

/** Immutable Git change produced by a code-surface optimizer. */
export interface AgentCandidateGitPatch {
  kind: "git-patch";
  repository: AgentCandidateGitHubRepository;
  baseCommit: string;
  baseTree: string;
  candidateTree: string;
  patch: {
    format: "git-diff-binary";
    artifact: AgentCandidateEmbeddedArtifact;
  };
}

export type AgentCandidateCode =
  | AgentCandidateCodeDisabled
  | AgentCandidateCodeNoOp
  | AgentCandidateGitPatch;

/** Pinned base image selected by the candidate contract. */
export interface AgentCandidateContainer {
  image: string;
  indexDigest: Sha256Digest;
}

/** Candidate-selected container whose bytes are fixed in the bundle. */
export interface AgentCandidatePinnedContainerEnvironment {
  kind: "pinned-container";
  container: AgentCandidateContainer;
}

/**
 * Benchmark-controlled task container selected per task by the evaluator.
 *
 * The runtime must bind the selected image index, manifest, platform, and task
 * workspace in the per-task execution plan and materialization receipt.
 */
export interface AgentCandidateEvaluatorTaskEnvironment {
  kind: "evaluator-task-container";
}

export type AgentCandidateExecutionEnvironment =
  | AgentCandidatePinnedContainerEnvironment
  | AgentCandidateEvaluatorTaskEnvironment;

export interface AgentCandidateWorkingDirectory {
  workspace: "candidate" | "task";
  path: string;
}

export interface AgentCandidateContainerLaunch {
  kind: "container-command";
  executable: string;
  args?: AgentCandidateConfigValue[];
}

export interface AgentCandidateEntrypointLaunch {
  kind: "candidate-entrypoint";
  entrypoint: string;
  interpreter?: "node" | "python" | "python3" | "bun" | "deno" | "tsx" | "uv";
  args?: AgentCandidateConfigValue[];
}

export type AgentCandidateLaunch =
  | AgentCandidateContainerLaunch
  | AgentCandidateEntrypointLaunch;

/** Closed delivery modes for the exact agent-visible UTF-8 task instruction. */
export type AgentCandidateInstructionDelivery =
  /** Append one final argv element after candidate args and materializer flags. */
  | { kind: "argv-append" }
  /** Write the exact bytes to stdin, then close stdin. */
  | { kind: "stdin-utf8" }
  /** Write exact bytes to the fixed path and expose that path through the fixed env name. */
  | {
      kind: "utf8-file";
      env: "TANGLE_CANDIDATE_TASK_PATH";
      path: "/tangle/input/task.txt";
    };

/** Shell-free execution contract for replaying a candidate. */
export interface AgentCandidateExecution {
  harness: HarnessType;
  harnessVersion: string;
  launch: AgentCandidateLaunch;
  instructionDelivery: AgentCandidateInstructionDelivery;
  cwd: AgentCandidateWorkingDirectory;
  env?: Record<string, AgentCandidateConfigValue>;
  environment: AgentCandidateExecutionEnvironment;
  /** Complete executable directory after build, before task execution. */
  workspace?: AgentCandidateWorkspaceSnapshotEvidence;
  isolation: {
    network: "disabled";
    remoteIntegrations: "disabled";
    candidateSecrets: "disabled";
  };
}

/** Optional immutable knowledge snapshot mounted with the profile. */
export interface AgentCandidateKnowledge {
  snapshotId: string;
  manifest: AgentCandidateArtifactRef;
}

/** Memory is absent or freshly evaluator-scoped to exactly one task. */
export type AgentCandidateMemoryPolicy =
  | { mode: "disabled" }
  | {
      mode: "isolated";
      scope: "task";
      seed?: AgentCandidateArtifactRef;
    };

/** Captured model spend for one phase of candidate production. */
export interface AgentCandidateSpend {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  modelCalls: number;
}

/** Lossless evaluator-owned usage totals for one candidate execution. */
export interface AgentCandidateFixedSpend {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  modelCalls: number;
  /** Integer billionths of one US dollar. */
  costUsdNanos: number;
}

/** Evidence and ancestry that produced the immutable candidate. */
export interface AgentCandidateLineage {
  source: "optimizer" | "human" | "import" | "compound";
  parentDigests?: Sha256Digest[];
  runIds?: string[];
  profileDiffIds?: string[];
  modelSnapshots?: string[];
  benchmark?: {
    name: string;
    version: string;
    splitDigest: Sha256Digest;
  };
  spend?: {
    proposal: AgentCandidateSpend;
    evaluation: AgentCandidateSpend;
  };
}

/**
 * Portable, immutable output of agent improvement.
 *
 * The digest is RFC 8785 canonical JSON hashed with SHA-256 after omitting the
 * digest field itself. Parsing proves structure only. Consumers must use the
 * runtime integrity verifier before materialization; the carried digest and all
 * artifact hashes are untrusted until recomputed.
 */
export interface AgentCandidateBundleV1 {
  schemaVersion: 1;
  kind: "agent-candidate-bundle";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  profile: AgentCandidateProfile;
  code: AgentCandidateCode;
  execution: AgentCandidateExecution;
  knowledge?: AgentCandidateKnowledge;
  memory: AgentCandidateMemoryPolicy;
  lineage: AgentCandidateLineage;
  digest: Sha256Digest;
}

export type AgentCandidateBundle = AgentCandidateBundleV1;

export interface AgentCandidateEntrypointReceipt {
  path: string;
  sha256: Sha256Digest;
  byteLength: number;
}

export interface AgentCandidateOciPlatform {
  os: string;
  architecture: string;
  variant?: string;
}

export interface AgentCandidateResolvedModel {
  requested: string;
  provider: string;
  model: string;
  snapshot: string;
  reasoningEffort: ReasoningEffort;
}

/** Canonical, digest-free profile-plan identity document. */
export interface AgentCandidateProfilePlanMaterialV1 {
  version: 1;
  harness: HarnessType;
  files: Array<{
    relPath: string;
    mode: number;
    contentSha256: Sha256Digest;
  }>;
  env: Record<string, AgentCandidateConfigValue>;
  flags: AgentCandidateConfigValue[];
  unsupported: Array<{ dimension: string; reason: string }>;
}

export interface AgentCandidateWorkspaceManifestMaterialV1 {
  schemaVersion: 1;
  kind: "agent-candidate-workspace-manifest";
  files: Array<{
    path: string;
    mode: 0o644 | 0o755;
    sha256: Sha256Digest;
    byteLength: number;
  }>;
}

/** Content-addressed manifest of every file uploaded to one workspace. */
export interface AgentCandidateWorkspaceSnapshotEvidence {
  schemaVersion: 1;
  kind: "agent-candidate-workspace-snapshot";
  digest: Sha256Digest;
  material: AgentCandidateWorkspaceManifestMaterialV1;
  manifest: AgentCandidateCapturedArtifact;
  archive: AgentCandidateCapturedArtifact;
}

export interface AgentCandidateMemoryReset {
  kind: "fresh";
  evidence: AgentCandidateCapturedArtifact;
  emptyStateDigest: Sha256Digest;
}

export type AgentCandidateEffectiveMemory =
  | { mode: "disabled" }
  | {
      mode: "isolated";
      scope: "task";
      effectiveNamespace: string;
      reset: AgentCandidateMemoryReset;
      beforeState: AgentCandidateWorkspaceSnapshotEvidence;
      seedDigest?: Sha256Digest;
    };

/** The exact evaluator-owned limits applied to every candidate arm. */
export interface AgentCandidateExecutionLimits {
  timeoutMs: number;
  maxSteps: number;
  maxModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
}

/** Counted attempt identity and the only retry class allowed by the evaluator. */
export interface AgentCandidateAttemptPolicy {
  number: number;
  maxAttempts: number;
  retryPolicy: "pre-model-infrastructure-only" | "none";
}

/** Exact workspace placement of one fully supported profile plan. */
export interface AgentCandidateProfileApplication {
  planDigest: Sha256Digest;
  targetWorkspace: AgentCandidateWorkingDirectory["workspace"];
  mountPaths: string[];
}

/**
 * Canonical, digest-free per-task execution identity document.
 *
 * RFC 8785 serialization of this material is stored verbatim by the receipt;
 * its raw SHA-256 is the execution-plan digest.
 */
export interface AgentCandidateExecutionPlanMaterialV1 {
  schemaVersion: 1;
  kind: "agent-candidate-execution-plan-material";
  bundleDigest: Sha256Digest;
  executionId: string;
  attempt: AgentCandidateAttemptPolicy;
  task: {
    benchmark: string;
    benchmarkVersion: string;
    taskId: string;
    splitDigest: Sha256Digest;
    instruction: {
      encoding: "utf8";
      sha256: Sha256Digest;
      byteLength: number;
      delivery: AgentCandidateInstructionDelivery;
    };
    repository: {
      identity: string;
      rootIdentity: string;
      baseCommit: string;
      baseTree: string;
    };
    workspace: AgentCandidateWorkspaceSnapshotEvidence;
  };
  workspaces: {
    taskRoot: string;
    candidateRoot?: string;
  };
  codeKind: AgentCandidateCode["kind"];
  candidateWorkspace?: AgentCandidateWorkspaceSnapshotEvidence;
  profile: AgentCandidateProfileApplication;
  harness: HarnessType;
  harnessVersion: string;
  container: {
    source: AgentCandidateExecutionEnvironment["kind"];
    image: string;
    indexDigest: Sha256Digest;
    manifestDigest: Sha256Digest;
    platform: AgentCandidateOciPlatform;
  };
  model: {
    policy: "single";
    resolved: AgentCandidateResolvedModel;
    access: {
      kind: "evaluator-mediated";
      grantDigest: Sha256Digest;
    };
    routes: Array<
      | { kind: "primary"; requested?: string }
      | { kind: "small"; requested: string }
      | { kind: "mode"; name: string; requested: string }
      | { kind: "subagent"; name: string; requested: string }
    >;
  };
  launch: {
    executable: string;
    args: AgentCandidateConfigValue[];
    env: Record<string, AgentCandidateConfigValue>;
    cwd: AgentCandidateWorkingDirectory;
  };
  knowledgeManifestDigest?: Sha256Digest;
  memory: AgentCandidateEffectiveMemory;
  limits: AgentCandidateExecutionLimits;
  network: { mode: "disabled" };
}

export interface AgentCandidateProfilePlanEvidence {
  schemaVersion: 1;
  kind: "agent-profile-workspace-plan";
  digest: Sha256Digest;
  material: AgentCandidateProfilePlanMaterialV1;
  artifact: AgentCandidateCapturedArtifact;
}

export interface AgentCandidateExecutionPlanEvidence {
  schemaVersion: 1;
  kind: "agent-candidate-execution-plan";
  digest: Sha256Digest;
  material: AgentCandidateExecutionPlanMaterialV1;
  artifact: AgentCandidateCapturedArtifact;
}

export interface AgentCandidateTraceEvidence {
  schemaVersion: 1;
  artifact: AgentCandidateCapturedArtifact;
  eventCount: number;
  modelCallCount: number;
}

export interface AgentCandidateModelUsage {
  resolved: AgentCandidateResolvedModel;
  usage: AgentCandidateSpend;
}

export type AgentCandidateMemoryReceipt =
  | { mode: "disabled" }
  | {
      mode: "isolated";
      scope: "task";
      effectiveNamespace: string;
      resetEvidenceDigest: Sha256Digest;
      beforeStateDigest: Sha256Digest;
      afterState: AgentCandidateWorkspaceSnapshotEvidence;
    };

/** Proof emitted after a runtime materializes, but before it executes, a bundle. */
export interface AgentCandidateMaterializationReceiptV1 {
  schemaVersion: 1;
  kind: "agent-candidate-materialization";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  bundleDigest: Sha256Digest;
  profilePlan: AgentCandidateProfilePlanEvidence;
  executionPlan: AgentCandidateExecutionPlanEvidence;
  candidateWorkspace?: AgentCandidateWorkspaceSnapshotEvidence;
  codeKind: AgentCandidateCode["kind"];
  materializedTree?: string;
  harness: HarnessType;
  harnessVersion: string;
  container: {
    source: AgentCandidateExecutionEnvironment["kind"];
    image: string;
    indexDigest: Sha256Digest;
    manifestDigest: Sha256Digest;
    platform: AgentCandidateOciPlatform;
  };
  resolvedModel: AgentCandidateResolvedModel;
  knowledgeManifestDigest?: Sha256Digest;
  entrypoint?: AgentCandidateEntrypointReceipt;
  digest: Sha256Digest;
}

export type AgentCandidateMaterializationReceipt =
  AgentCandidateMaterializationReceiptV1;

/** How an execution ended, independent of whether protected evidence capture completed. */
export type AgentCandidateTermination =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "signal"; signal: string }
  | { kind: "cancelled" };

/** Proof emitted after the exact materialized plan finishes executing. */
export interface AgentCandidateRunReceiptV1 {
  schemaVersion: 1;
  kind: "agent-candidate-run";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  bundleDigest: Sha256Digest;
  materializationReceiptDigest: Sha256Digest;
  executionPlanDigest: Sha256Digest;
  memory: AgentCandidateMemoryReceipt;
  usage: AgentCandidateSpend;
  modelUsage: AgentCandidateModelUsage;
  trace: AgentCandidateTraceEvidence;
  termination: AgentCandidateTermination;
  digest: Sha256Digest;
}

/** One evaluator-mediated model call in a terminal settlement. */
export interface AgentCandidateModelSettlementCall {
  callId: string;
  traceSpanId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsdNanos: number;
}

/** Canonical model-access ledger after the evaluator has revoked the grant. */
export interface AgentCandidateModelSettlementMaterialV1 {
  schemaVersion: 1;
  kind: "agent-candidate-model-settlement-material";
  executionPlanDigest: Sha256Digest;
  preparationId: string;
  grantDigest: Sha256Digest;
  closed: true;
  resolved: AgentCandidateResolvedModel;
  calls: AgentCandidateModelSettlementCall[];
  usage: AgentCandidateFixedSpend;
}

export interface AgentCandidateModelSettlementEvidence {
  schemaVersion: 1;
  kind: "agent-candidate-model-settlement";
  digest: Sha256Digest;
  material: AgentCandidateModelSettlementMaterialV1;
  artifact: AgentCandidateCapturedArtifact;
}

/** Git identity before or after a task execution. */
export interface AgentCandidateRepositoryState {
  identity: string;
  rootIdentity: string;
  commit: string;
  tree: string;
}

/** Canonical repository result produced by the candidate on one task. */
export interface AgentCandidateTaskOutcomeMaterialV1 {
  schemaVersion: 1;
  kind: "agent-candidate-task-outcome-material";
  executionPlanDigest: Sha256Digest;
  baseRepository: AgentCandidateRepositoryState;
  resultRepository: AgentCandidateRepositoryState;
  afterState: AgentCandidateWorkspaceSnapshotEvidence;
  gitDiff: {
    format: "git-diff-binary";
    artifact: AgentCandidateArtifactRef;
  };
}

export interface AgentCandidateTaskOutcomeEvidence {
  schemaVersion: 1;
  kind: "agent-candidate-task-outcome";
  digest: Sha256Digest;
  material: AgentCandidateTaskOutcomeMaterialV1;
  artifact: AgentCandidateCapturedArtifact;
}

export interface AgentCandidateBenchmarkDimension {
  name: string;
  score: number;
}

/** Canonical executable-grade result for one task outcome. */
export interface AgentCandidateBenchmarkResultMaterialV1 {
  schemaVersion: 1;
  kind: "agent-candidate-benchmark-result-material";
  executionPlanDigest: Sha256Digest;
  taskOutcomeDigest: Sha256Digest;
  benchmark: {
    name: string;
    version: string;
    taskId: string;
    splitDigest: Sha256Digest;
  };
  grader: {
    name: string;
    version: string;
    artifact: AgentCandidateArtifactRef;
  };
  score: number;
  dimensions: AgentCandidateBenchmarkDimension[];
}

export interface AgentCandidateBenchmarkResultEvidence {
  schemaVersion: 1;
  kind: "agent-candidate-benchmark-result";
  digest: Sha256Digest;
  material: AgentCandidateBenchmarkResultMaterialV1;
  artifact: AgentCandidateCapturedArtifact;
}

/**
 * Terminal candidate receipt with lossless spend, exact repository output,
 * and executable benchmark evidence. V1 fields remain present for consumers
 * that have not yet adopted the stronger evidence surfaces.
 */
export interface AgentCandidateRunReceiptV2
  extends Omit<AgentCandidateRunReceiptV1, "schemaVersion"> {
  schemaVersion: 2;
  fixedUsage: AgentCandidateFixedSpend;
  modelSettlement: AgentCandidateModelSettlementEvidence;
  taskOutcome: AgentCandidateTaskOutcomeEvidence;
  benchmarkResult: AgentCandidateBenchmarkResultEvidence;
}

/** Backward-compatible V1 receipt name. */
export type AgentCandidateRunReceipt = AgentCandidateRunReceiptV1;

/** Explicit parser target for consumers that accept both receipt generations. */
export type AgentCandidateRunReceiptAnyVersion =
  | AgentCandidateRunReceiptV1
  | AgentCandidateRunReceiptV2;

/** Declare a candidate bundle while retaining literal inference. */
export function defineAgentCandidateBundle<T extends AgentCandidateBundle>(
  bundle: T,
): T {
  return bundle;
}

/**
 * Type-only guard that candidate resources remain intentionally distinct from
 * the mutable generic AgentProfile resource shape.
 */
type MutableResourceMustNotSatisfyFrozen = AgentProfileResourceRef extends AgentCandidateResourceRef
  ? never
  : true;
const _mutableResourceMustNotSatisfyFrozen: MutableResourceMustNotSatisfyFrozen =
  true;
void _mutableResourceMustNotSatisfyFrozen;
