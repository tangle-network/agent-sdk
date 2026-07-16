import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileHookCommand,
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

/** Finite, acyclic JSON accepted by canonical candidate documents. */
export type AgentCandidateJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentCandidateJsonValue[]
  | { [key: string]: AgentCandidateJsonValue };

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

interface AgentCandidateLocalMcpServer {
  transport?: "stdio";
  command: string;
  args?: AgentCandidateConfigValue[];
  env?: Record<string, AgentCandidateConfigValue>;
  cwd?: string;
  enabled?: true;
}

interface AgentCandidateDisabledMcpServer {
  enabled: false;
  transport?: never;
  command?: never;
  args?: never;
  env?: never;
  cwd?: never;
}

export type AgentCandidateMcpServer =
  | AgentCandidateLocalMcpServer
  | AgentCandidateDisabledMcpServer;

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

/** Exact frozen knowledge candidate admitted only through an approved review. */
export interface AgentCandidateKnowledgeRef {
  kind: "knowledge-improvement-candidate";
  runId: string;
  candidateId: string;
  goalHash: Sha256Digest;
  baseHash: Sha256Digest;
  candidateHash: Sha256Digest;
  evidenceHash: Sha256Digest;
  promotionPlanHash: Sha256Digest;
}

export interface AgentCandidateKnowledge {
  candidate: AgentCandidateKnowledgeRef;
  snapshot: AgentCandidateWorkspaceSnapshotEvidence;
  retrievalConfig?: AgentCandidateCapturedArtifact;
  evaluation: AgentCandidateCapturedArtifact;
}

/** Memory is absent or freshly evaluator-scoped to exactly one task. */
export type AgentCandidateMemoryPolicy =
  | { mode: "disabled" }
  | {
      mode: "isolated";
      scope: "task";
      seed?: AgentCandidateArtifactRef;
    };

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
  /** Exact development split used to produce a generated candidate. */
  developmentSplitDigest?: Sha256Digest;
}

/**
 * Portable, immutable output of agent improvement.
 *
 * The digest is RFC 8785 canonical JSON hashed with SHA-256 after omitting the
 * digest field itself. Parsing proves structure only. Consumers must use the
 * runtime integrity verifier before materialization; the carried digest and all
 * artifact hashes are untrusted until recomputed.
 */
export interface AgentCandidateBundle {
  kind: "agent-candidate-bundle";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  profile: AgentCandidateProfile;
  code: AgentCandidateCode;
  execution: AgentCandidateExecution;
  knowledge?: AgentCandidateKnowledge;
  memory: AgentCandidateMemoryPolicy;
  digest: Sha256Digest;
}

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

/** Exact evaluator-selected task image used when the candidate does not pin one. */
export interface AgentCandidateResolvedTaskContainer {
  source: "evaluator-task-container";
  image: string;
  indexDigest: Sha256Digest;
  manifestDigest: Sha256Digest;
  platform: AgentCandidateOciPlatform;
}

export interface AgentCandidateResolvedModel {
  requested: string;
  provider: string;
  model: string;
  snapshot: string;
  reasoningEffort: ReasoningEffort;
}

/** Canonical, digest-free profile-plan identity document. */
export interface AgentCandidateProfilePlanMaterial {
  /** Canonical digest of the complete frozen profile that produced this plan. */
  sourceProfileDigest: Sha256Digest;
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

export interface AgentCandidateWorkspaceManifestMaterial {
  kind: "agent-candidate-workspace-manifest";
  files: Array<{
    path: string;
    /** Exact regular-file permission bits, excluding file-type and special bits. */
    mode: number;
    sha256: Sha256Digest;
    byteLength: number;
  }>;
}

/** Content-addressed manifest of every file uploaded to one workspace. */
export interface AgentCandidateWorkspaceSnapshotEvidence {
  kind: "agent-candidate-workspace-snapshot";
  digest: Sha256Digest;
  material: AgentCandidateWorkspaceManifestMaterial;
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

/** Evaluator-owned network exception for the one frozen model gateway. */
export type AgentCandidateModelAccessNetwork =
  | { mode: "disabled" }
  | { mode: "gateway-only"; domains: string[] };

/** Optional source repository identity for a signed benchmark task. */
export interface AgentCandidateTaskRepository {
  identity: string;
  rootIdentity: string;
  baseCommit: string;
  baseTree: string;
}

/** Bounded media contract for one exact non-workspace task result. */
export interface AgentCandidateTaskOutputSpec {
  /** Evaluator-declared label; the bound grader verifies the bytes match it. */
  mediaType: string;
  maxBytes: number;
}

/** Exact result shape the evaluator must capture after one candidate task. */
export type AgentCandidateTaskOutcomeSpec =
  | { kind: "workspace" }
  | ({ kind: "output" } & AgentCandidateTaskOutputSpec);

/** Immutable grader identity admitted for one benchmark task. */
export interface AgentCandidateBenchmarkGraderIdentity {
  name: string;
  version: string;
  format: "tangle-grader";
  artifact: AgentCandidateArtifactRef;
}

/** Portable task bytes shared by evaluation, approval, and execution. */
export interface AgentCandidateBenchmarkTaskMaterial {
  kind: "agent-candidate-benchmark-task";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  benchmark: {
    name: string;
    version: string;
    splitDigest: Sha256Digest;
  };
  scenario: {
    id: string;
    kind: string;
    scenarioDigest: Sha256Digest;
  };
  datasetSnapshot?: AgentCandidateArtifactRef;
  instruction: string;
  repository?: AgentCandidateTaskRepository;
  outcome: AgentCandidateTaskOutcomeSpec;
  workspace: AgentCandidateWorkspaceSnapshotEvidence;
  grader: AgentCandidateBenchmarkGraderIdentity;
  model: AgentCandidateResolvedModel;
  attempt: Omit<AgentCandidateAttemptPolicy, "number">;
  evaluatorTaskContainer?: AgentCandidateResolvedTaskContainer;
  limits: AgentCandidateExecutionLimits;
}

/** Content-addressed benchmark task approved and executed without reinterpretation. */
export interface AgentCandidateBenchmarkTask
  extends AgentCandidateBenchmarkTaskMaterial {
  digest: Sha256Digest;
}

/** Complete measured denominator shared by evaluation and execution. */
export interface AgentCandidateBenchmarkSuiteMaterial {
  kind: "agent-candidate-benchmark-suite";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  taskDigests: [Sha256Digest, ...Sha256Digest[]];
  reps: number;
  /** Task-major, then repetition-major: seeds[taskIndex * reps + repetition]. */
  seeds: [number, ...number[]];
}

export interface AgentCandidateBenchmarkSuite
  extends AgentCandidateBenchmarkSuiteMaterial {
  digest: Sha256Digest;
}

/** Canonical task documents transported alongside their signed suite. */
export interface AgentCandidateBenchmarkSuiteInputs {
  suite: AgentCandidateBenchmarkSuite;
  tasks: [AgentCandidateBenchmarkTask, ...AgentCandidateBenchmarkTask[]];
}

/** One cell in a signed suite; task identity and seed are derived by position. */
export interface AgentCandidateBenchmarkCellRef {
  suiteDigest: Sha256Digest;
  taskIndex: number;
  repetition: number;
}

/** Decision rules frozen before either experiment arm executes. */
export interface AgentCandidateEvaluationPolicy {
  confidenceLevel: number;
  resamples: number;
  bootstrapSeed: number;
  deltaThreshold: number;
  minProductiveRuns: number;
  budgetUsd?: number;
  criticalDimensions: string[];
  regressionTolerance: number;
}

/** Both complete agent states and the exact held-out work used to compare them. */
export interface AgentCandidateExperimentMaterial {
  kind: "agent-candidate-experiment";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  baseline: AgentCandidateBundle;
  candidate: AgentCandidateBundle;
  candidateLineage: AgentCandidateLineage;
  benchmark: AgentCandidateBenchmarkSuiteInputs;
  policy: AgentCandidateEvaluationPolicy;
}

export interface AgentCandidateExperiment
  extends AgentCandidateExperimentMaterial {
  digest: Sha256Digest;
}

/** Digest-free identity of one exact attempt in a frozen experiment. */
export interface AgentCandidateRunCellMaterial
  extends AgentCandidateBenchmarkCellRef {
  kind: "agent-candidate-run-cell";
  experimentDigest: Sha256Digest;
  arm: "baseline" | "candidate";
  bundleDigest: Sha256Digest;
  taskDigest: Sha256Digest;
  seed: number;
  attempt: number;
}

/** One immutable experiment attempt used by plans, receipts, traces, and results. */
export interface AgentCandidateRunCell extends AgentCandidateRunCellMaterial {
  digest: Sha256Digest;
}

/**
 * Canonical, digest-free per-task execution identity document.
 *
 * RFC 8785 serialization of this material is stored verbatim by the receipt;
 * its raw SHA-256 is the execution-plan digest.
 */
export interface AgentCandidateExecutionPlanMaterial {
  kind: "agent-candidate-execution-plan-material";
  runCell: AgentCandidateRunCell;
  executionId: string;
  workspaces: {
    taskRoot: string;
    candidateRoot?: string;
  };
  codeKind: AgentCandidateCode["kind"];
  candidateWorkspace?: AgentCandidateWorkspaceSnapshotEvidence;
  profile: AgentCandidateProfileApplication;
  harness: HarnessType;
  harnessVersion: string;
  instructionDelivery: AgentCandidateInstructionDelivery;
  limits: AgentCandidateExecutionLimits;
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
      network: AgentCandidateModelAccessNetwork;
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
  network: { mode: "disabled" };
}

export interface AgentCandidateProfilePlanEvidence {
  kind: "agent-profile-workspace-plan";
  digest: Sha256Digest;
  material: AgentCandidateProfilePlanMaterial;
  artifact: AgentCandidateCapturedArtifact;
}

/** Exact native profile files and the canonical plan that activated them. */
export interface AgentCandidateProfileActivation {
  kind: "agent-candidate-profile-activation";
  profilePlan: AgentCandidateProfilePlanEvidence;
  files: Array<{
    path: string;
    mode: number;
    content: string;
  }>;
  digest: Sha256Digest;
}

export interface AgentCandidateExecutionPlanEvidence {
  kind: "agent-candidate-execution-plan";
  digest: Sha256Digest;
  material: AgentCandidateExecutionPlanMaterial;
  artifact: AgentCandidateCapturedArtifact;
}

/** Exact suite and task material selected for one execution plan. */
export interface AgentCandidateBenchmarkInputEvidence {
  suite: {
    digest: Sha256Digest;
    material: AgentCandidateCapturedArtifact;
  };
  task: {
    digest: Sha256Digest;
    material: AgentCandidateCapturedArtifact;
  };
}

export interface AgentCandidateTraceEvidence {
  artifact: AgentCandidateCapturedArtifact;
  eventCount: number;
  modelCallCount: number;
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
export interface AgentCandidateMaterializationReceipt {
  kind: "agent-candidate-materialization";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  bundleDigest: Sha256Digest;
  benchmark: AgentCandidateBenchmarkInputEvidence;
  profileActivation: AgentCandidateProfileActivation;
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

/** How an execution ended, independent of whether protected evidence capture completed. */
export type AgentCandidateTermination =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "signal"; signal: string }
  | { kind: "cancelled" };

/** Proof emitted after the exact materialized plan finishes executing. */
export interface AgentCandidateRunReceipt {
  kind: "agent-candidate-run";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  bundleDigest: Sha256Digest;
  runCellDigest: Sha256Digest;
  materializationReceiptDigest: Sha256Digest;
  executionPlanDigest: Sha256Digest;
  timing: {
    startedAtMs: number;
    endedAtMs: number;
    durationMs: number;
  };
  memory: AgentCandidateMemoryReceipt;
  trace: AgentCandidateTraceEvidence;
  termination: AgentCandidateTermination;
  executorCapture: AgentCandidateArtifactRef;
  modelSettlement: AgentCandidateModelSettlementEvidence;
  taskOutcome: AgentCandidateTaskOutcomeEvidence;
  benchmarkResult: AgentCandidateBenchmarkResultEvidence;
  digest: Sha256Digest;
}

export type AgentImprovementSurface =
  | "prompt"
  | "skills"
  | "tools"
  | "mcp"
  | "hooks"
  | "subagents"
  | "agent-profile"
  | "memory"
  | "code"
  | "knowledge";

/** One paired Runtime execution from the exact signed experiment. */
export interface AgentCandidateExperimentMeasurement {
  baseline: CandidateExecutionEvidence;
  candidate: CandidateExecutionEvidence;
}

/** Portable paired held-out comparison produced by an evaluation package. */
export interface AgentImprovementMeasuredComparison {
  kind: "agent-improvement-measured-comparison";
  experiment: AgentCandidateExperiment;
  measurements: AgentCandidateExperimentMeasurement[];
  overall: {
    name: "composite";
    baseline: number;
    candidate: number;
    delta: number;
    confidenceInterval: {
      level: number;
      lower: number;
      upper: number;
      method: "paired-bootstrap";
      statistic: "mean";
      resamples: number;
    };
    n: number;
    direction: "higher-is-better";
    unit: "score";
  };
  objectives: Array<
    (
      | {
          kind: "objective";
          name: string;
          direction: "higher-is-better";
          unit: "score";
        }
      | {
          kind: "dimension";
          objective: string;
          name: string;
          direction: "higher-is-better";
          unit: "score";
        }
      | {
          kind: "cost";
          name: "cost";
          direction: "lower-is-better";
          unit: "usd";
        }
      | {
          kind: "latency";
          name: "latency";
          direction: "lower-is-better";
          unit: "milliseconds";
        }
    ) &
      (
        | {
            availability: "measured";
            baseline: number;
            candidate: number;
            delta: number;
            confidenceInterval: {
              level: number;
              lower: number;
              upper: number;
              method: "paired-bootstrap";
              statistic: "mean";
              resamples: number;
            };
            n: number;
          }
        | { availability: "unavailable"; reason: string }
      )
  >;
  candidate?: {
    label?: string;
    rationale?: string;
  };
  decision: {
    outcome:
      | "ship"
      | "hold"
      | "need_more_work"
      | "model_ceiling"
      | "arch_ceiling";
    reasons: string[];
    contributingChecks: Array<{ name: string; passed: boolean }>;
  };
  power: {
    sufficient: boolean;
    n: number;
    minimumDetectableDelta: number;
    confidenceLevel: number;
    scaleAssumed: boolean;
    sharedScorerChannel: boolean;
    reason: string;
  };
  provenance: {
    kind: "agent-eval-loop";
    schema: string;
    runId: string;
    recordDigest: Sha256Digest;
    baselineContentHash: string;
    candidateContentHash: string;
  };
  diff: string;
  evaluation: {
    generationsExplored: number;
    searchDurationMs: number;
    executionDurationMs: number;
    durationMs: number;
    searchCostUsd: number;
    executionCostUsd: number;
    totalCostUsd: number;
  };
  metadata?: { [key: string]: AgentCandidateJsonValue };
}

export interface AgentImprovementProposal {
  kind: "agent-improvement-proposal";
  runId: string;
  changedSurfaces: [AgentImprovementSurface, ...AgentImprovementSurface[]];
  proposedAt: string;
  findings: { [key: string]: AgentCandidateJsonValue }[];
  evaluation: AgentImprovementMeasuredComparison;
  digest: Sha256Digest;
}

export type AgentImprovementReviewDecision =
  | "approve"
  | "reject"
  | "request-changes";

/** Human or tenant-policy decision bound to one exact proposal. */
export interface AgentImprovementReview {
  kind: "agent-improvement-review";
  proposalDigest: Sha256Digest;
  decision: AgentImprovementReviewDecision;
  reviewedBy: string;
  reviewedAt: string;
  reason: string;
  feedback?: string;
  digest: Sha256Digest;
}

export interface AgentImprovementActivationTarget {
  surface: AgentImprovementSurface;
  /** Product-owned stable identity, such as an agent profile, repository, or knowledge base. */
  identity: string;
  /** Current target state that activation is allowed to replace. */
  expectedBaseDigest: Sha256Digest;
}

/** Authority receipt permitting activation of one already-measured candidate. */
export interface AgentImprovementActivation {
  kind: "agent-improvement-activation";
  proposalDigest: Sha256Digest;
  reviewDigest: Sha256Digest;
  experimentDigest: Sha256Digest;
  candidateBundleDigest: Sha256Digest;
  targets: [AgentImprovementActivationTarget, ...AgentImprovementActivationTarget[]];
  fundingOwner: string;
  authorizedBy: string;
  authorizedAt: string;
  digest: Sha256Digest;
}

/** Complete execution of one exact experiment attempt. */
export interface CandidateExecutionEvidence {
  kind: "agent-candidate-execution-evidence";
  materializationReceipt: AgentCandidateMaterializationReceipt;
  receipt: AgentCandidateRunReceipt;
  digest: Sha256Digest;
}

/** One router-authored model call in a terminal settlement. */
export interface AgentCandidateModelSettlementCall {
  callId: string;
  generationId: string;
  traceSpanId: string;
  status: "succeeded" | "failed";
  model: string;
  startedAtMs: number;
  endedAtMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsdNanos: number;
}

/** Canonical model-access ledger after the evaluator has revoked access. */
export interface AgentCandidateModelSettlementMaterial {
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
  kind: "agent-candidate-model-settlement";
  digest: Sha256Digest;
  material: AgentCandidateModelSettlementMaterial;
  artifact: AgentCandidateCapturedArtifact;
}

/** Git identity before or after a task execution. */
export interface AgentCandidateRepositoryState {
  identity: string;
  rootIdentity: string;
  commit: string;
  tree: string;
}

/** Canonical result captured by the evaluator after one candidate task. */
export interface AgentCandidateTaskOutcomeMaterial {
  kind: "agent-candidate-task-outcome-material";
  executionPlanDigest: Sha256Digest;
  outcome:
    | {
        kind: "workspace";
        baseRepository: AgentCandidateRepositoryState;
        resultRepository: AgentCandidateRepositoryState;
        afterState: AgentCandidateWorkspaceSnapshotEvidence;
        gitDiff: {
          format: "git-diff-binary";
          artifact: AgentCandidateArtifactRef;
        };
      }
      | {
          kind: "output";
          spec: AgentCandidateTaskOutputSpec;
          artifact: AgentCandidateArtifactRef;
        };
}

export interface AgentCandidateTaskOutcomeEvidence {
  kind: "agent-candidate-task-outcome";
  digest: Sha256Digest;
  material: AgentCandidateTaskOutcomeMaterial;
  artifact: AgentCandidateCapturedArtifact;
}

export interface AgentCandidateBenchmarkDimension {
  name: string;
  score: number;
}

/** Canonical executable-grade result for one task outcome. */
export interface AgentCandidateBenchmarkResultMaterial {
  kind: "agent-candidate-benchmark-result-material";
  executionPlanDigest: Sha256Digest;
  taskOutcomeDigest: Sha256Digest;
  grader: AgentCandidateBenchmarkGraderIdentity;
  /** Raw grader output required to independently audit the reported verdict. */
  evidence: AgentCandidateArtifactRef;
  /** Evaluator-owned model usage and elapsed time, separate from candidate usage. */
  grading: {
    usage: AgentCandidateFixedSpend;
    timing: {
      startedAtMs: number;
      endedAtMs: number;
      durationMs: number;
    };
  };
  score: number;
  passed: boolean;
  dimensions: AgentCandidateBenchmarkDimension[];
}

export interface AgentCandidateBenchmarkResultEvidence {
  kind: "agent-candidate-benchmark-result";
  digest: Sha256Digest;
  material: AgentCandidateBenchmarkResultMaterial;
  artifact: AgentCandidateCapturedArtifact;
}

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
