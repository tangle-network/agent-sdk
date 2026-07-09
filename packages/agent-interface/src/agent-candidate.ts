import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileHookCommand,
  AgentProfileMcpServer,
  AgentProfileResourceRef,
  AgentProfileResources,
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

/** A deliberately public value; producers remain responsible for secret scanning. */
export interface AgentCandidatePublicValue {
  kind: "public";
  value: string;
}

/** A named secret resolved only by the sealed executor. */
export interface AgentCandidateSecretRef {
  kind: "secret";
  name: string;
}

export type AgentCandidateConfigValue =
  | AgentCandidatePublicValue
  | AgentCandidateSecretRef;

export interface AgentCandidateHttpsEndpoint {
  kind: "https";
  url: string;
}

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
  extends Omit<AgentProfileMcpServer, "args" | "env" | "headers" | "url"> {
  args?: AgentCandidateConfigValue[];
  env?: Record<string, AgentCandidateConfigValue>;
  url?: AgentCandidateHttpsEndpoint;
  headers?: Record<string, AgentCandidateConfigValue>;
}

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
    "mcp" | "resources" | "hooks" | "extensions"
  > {
  mcp?: Record<string, AgentCandidateMcpServer>;
  resources?: AgentCandidateResources;
  hooks?: Record<string, AgentCandidateHookCommand[]>;
}

export interface AgentCandidateCodeDisabled {
  kind: "disabled";
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

/** Shell-free execution contract for replaying a candidate. */
export interface AgentCandidateExecution {
  harness: HarnessType;
  harnessVersion: string;
  launch: AgentCandidateLaunch;
  cwd: AgentCandidateWorkingDirectory;
  env?: Record<string, AgentCandidateConfigValue>;
  environment: AgentCandidateExecutionEnvironment;
}

/** Optional immutable knowledge snapshot mounted with the profile. */
export interface AgentCandidateKnowledge {
  snapshotId: string;
  manifest: AgentCandidateArtifactRef;
}

/** Memory is either absent or isolated per run; cross-task writes are forbidden. */
export type AgentCandidateMemoryPolicy =
  | { mode: "disabled" }
  | {
      mode: "isolated";
      namespace: string;
      seed?: AgentCandidateArtifactRef;
      crossTaskWrites: false;
    };

/** Captured model spend for one phase of candidate production. */
export interface AgentCandidateSpend {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  modelCalls: number;
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
  provider: string;
  model: string;
  snapshot?: string;
}

/** Proof emitted after a runtime materializes, but before it executes, a bundle. */
export interface AgentCandidateMaterializationReceiptV1 {
  schemaVersion: 1;
  kind: "agent-candidate-materialization";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  bundleDigest: Sha256Digest;
  profilePlanDigest: Sha256Digest;
  executionPlanDigest: Sha256Digest;
  codeKind: AgentCandidateCode["kind"];
  materializedTree?: string;
  harness: HarnessType;
  harnessVersion: string;
  container: {
    source: AgentCandidateExecutionEnvironment["kind"];
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

/** Proof emitted after the exact materialized plan finishes executing. */
export interface AgentCandidateRunReceiptV1 {
  schemaVersion: 1;
  kind: "agent-candidate-run";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  bundleDigest: Sha256Digest;
  materializationReceiptDigest: Sha256Digest;
  executionPlanDigest: Sha256Digest;
  memory: AgentCandidateMemoryPolicy;
  usage: AgentCandidateSpend;
  trace: AgentCandidateArtifactRef;
  exitCode: number;
  digest: Sha256Digest;
}

export type AgentCandidateRunReceipt = AgentCandidateRunReceiptV1;

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
