import type {
  AgentCandidateBenchmarkDimension,
  AgentCandidateBenchmarkGraderIdentity,
  AgentCandidateDigestAlgorithm,
  AgentCandidateEvaluationPolicy,
  AgentCandidateExecutionLimits,
  AgentCandidateFixedSpend,
  AgentCandidateLineage,
  AgentCandidateResolvedModel,
  AgentImprovementMeasuredComparisonBase,
  Sha256Digest,
} from "./agent-candidate.js";
import type { AgentImprovementSource } from "./agent-improvement-source.js";
import type { AgentProfileDiff } from "./profile-diff.js";

/** An access-controlled evidence record emitted by a host-owned profile run. */
export interface AgentProfileImprovementEvidence {
  kind: string;
  identity: string;
  digest: Sha256Digest;
}

/** One profile task whose content and evaluator are frozen before either arm runs. */
export interface AgentProfileImprovementTaskMaterial {
  kind: "agent-profile-improvement-task";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  scenario: {
    id: string;
    kind: string;
    digest: Sha256Digest;
  };
  grader: AgentCandidateBenchmarkGraderIdentity;
  model: AgentCandidateResolvedModel;
  limits: AgentCandidateExecutionLimits;
}

export interface AgentProfileImprovementTask extends AgentProfileImprovementTaskMaterial {
  digest: Sha256Digest;
}

/** The full paired denominator for host-owned profile executions. */
export interface AgentProfileImprovementSuiteMaterial {
  kind: "agent-profile-improvement-suite";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  splitDigest: Sha256Digest;
  taskDigests: [Sha256Digest, ...Sha256Digest[]];
  reps: number;
  /** Task-major, then repetition-major. */
  seeds: [number, ...number[]];
}

export interface AgentProfileImprovementSuite extends AgentProfileImprovementSuiteMaterial {
  digest: Sha256Digest;
}

export interface AgentProfileImprovementSuiteInputs {
  suite: AgentProfileImprovementSuite;
  tasks: [AgentProfileImprovementTask, ...AgentProfileImprovementTask[]];
}

/** The complete profile state that actually runs. */
export interface AgentProfileImprovementArm {
  stateDigest: Sha256Digest;
}

/** Exact non-secret identity of the runner that measured and can activate a profile change. */
export interface AgentProfileImprovementExecutionRef extends AgentProfileImprovementEvidence {
  kind: "agent-profile-improvement-execution-ref";
}

/**
 * Ordered portable profile patches retained for review and activation.
 *
 * Applying the steps in order matters: a full resource replacement is a reset
 * followed by a replacement step. Prompt and inline skill content can be
 * sensitive, so the product that persists this value owns access control and
 * redaction.
 */
export type AgentProfileImprovementChange = [AgentProfileDiff, ...AgentProfileDiff[]];

/** A measured comparison of two states of one host-owned agent profile. */
export interface AgentProfileImprovementExperimentMaterial {
  kind: "agent-profile-improvement-experiment";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  source: AgentImprovementSource;
  executionRef: AgentProfileImprovementExecutionRef;
  baseline: AgentProfileImprovementArm;
  candidate: AgentProfileImprovementArm;
  change: AgentProfileImprovementChange;
  candidateLineage: AgentCandidateLineage;
  benchmark: AgentProfileImprovementSuiteInputs;
  policy: AgentCandidateEvaluationPolicy;
}

export interface AgentProfileImprovementExperiment
  extends AgentProfileImprovementExperimentMaterial {
  digest: Sha256Digest;
}

/** Exact identity for one profile attempt in a frozen experiment. */
export interface AgentProfileImprovementRunCellMaterial {
  kind: "agent-profile-improvement-run-cell";
  experimentDigest: Sha256Digest;
  arm: "baseline" | "candidate";
  stateDigest: Sha256Digest;
  suiteDigest: Sha256Digest;
  taskDigest: Sha256Digest;
  taskIndex: number;
  repetition: number;
  seed: number;
  attempt: number;
}

export interface AgentProfileImprovementRunCell
  extends AgentProfileImprovementRunCellMaterial {
  digest: Sha256Digest;
}

/** Verifiable output from one profile execution and its frozen evaluator. */
export interface AgentProfileImprovementRunReceipt {
  kind: "agent-profile-improvement-run";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  executionId: string;
  executionRef: AgentProfileImprovementExecutionRef;
  runCell: AgentProfileImprovementRunCell;
  runRecord: AgentProfileImprovementEvidence;
  billing: [AgentProfileImprovementEvidence, ...AgentProfileImprovementEvidence[]];
  timing: {
    startedAtMs: number;
    endedAtMs: number;
    durationMs: number;
  };
  steps: number;
  resolvedModel: AgentCandidateResolvedModel;
  limits: AgentCandidateExecutionLimits;
  usage: AgentCandidateFixedSpend;
  trace: {
    evidence: AgentProfileImprovementEvidence;
    eventCount: number;
    modelCallCount: number;
  };
  output: AgentProfileImprovementEvidence;
  outcome:
    | { status: "succeeded" }
    | { status: "failed"; code: string; message: string };
  grading: {
    grader: AgentCandidateBenchmarkGraderIdentity;
    evidence: AgentProfileImprovementEvidence;
    timing: {
      startedAtMs: number;
      endedAtMs: number;
      durationMs: number;
    };
    usage: AgentCandidateFixedSpend;
    score: number;
    passed: boolean;
    dimensions: AgentCandidateBenchmarkDimension[];
  };
  digest: Sha256Digest;
}

/** One paired result from the exact same task, seed, and evaluator. */
export interface AgentProfileImprovementMeasurement {
  baseline: AgentProfileImprovementRunReceipt;
  candidate: AgentProfileImprovementRunReceipt;
}

/** Portable paired comparison from ordinary profile executions. */
export interface AgentProfileImprovementMeasuredComparison
  extends AgentImprovementMeasuredComparisonBase<
    AgentProfileImprovementExperiment,
    AgentProfileImprovementMeasurement,
    "agent-profile-improvement-measured-comparison"
  > {
  kind: "agent-profile-improvement-measured-comparison";
}
