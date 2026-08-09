/**
 * Pure span builders.
 *
 * PURE means: no clock, no randomness, no I/O, no mutation of the caller's
 * objects. Ids and timestamps are arguments. A builder that called `Date.now()`
 * or generated its own span id could not be unit-tested for equality, could not
 * be replayed against a recorded trace, and would silently disagree with the
 * timestamps the producer already has from the thing it is describing. The
 * caller already knows when the work started; asking the builder to guess is
 * strictly worse.
 *
 * Every builder omits an attribute it was not given a usable value for. It never
 * writes a placeholder `0`, `""` or `"unknown"`, because a downstream sum cannot
 * tell a synthesized zero from a measured one.
 */

import {
  ATTR,
  attributeBag,
  LINK_KIND_ATTR,
  type LinkKind,
} from "./attributes.js";
import type {
  ContractSpan,
  Outcome,
  SpanKind,
  SpanLink,
  SpanStatus,
} from "./span.js";

/**
 * Fields shared by every builder.
 *
 * `attributes` is the escape hatch for anything the contract does not name. The
 * typed fields win over it: if both `model` and a raw `gen_ai.request.model` are
 * supplied, the typed one is written, so the builder's output never contradicts
 * its own arguments.
 */
export interface SpanInit {
  traceId: string;
  spanId: string;
  /** Omit or pass `null` for a root span. */
  parentSpanId?: string | null;
  name: string;
  /** ISO 8601. */
  startTime: string;
  /** ISO 8601; defaults to `startTime`, the contract's encoding of an instant. */
  endTime?: string;
  /** Defaults to `{ code: 'STATUS_CODE_UNSET' }` — unset, not OK. */
  status?: SpanStatus;
  /** Attributes the contract does not name; typed fields override these. */
  attributes?: Record<string, unknown>;
  links?: readonly SpanLink[];
  resource?: { attributes: Record<string, unknown> };
  /** Terminal verdict, when this span is the thing that was graded. */
  outcome?: Outcome;
  /** Numeric grade accompanying `outcome`. */
  score?: number;
}

/** {@link SpanInit} plus an explicit kind — the generic builder's input. */
export interface ContractSpanInit extends SpanInit {
  kind?: SpanKind;
}

/**
 * Build any span. The specialized builders below all funnel through this, so
 * there is exactly one place that decides field defaults and attribute
 * precedence.
 *
 * Use it directly for the spans the contract has no specialized builder for —
 * the AGENT run at the root, a CHAIN that is neither a loop iteration nor a tree
 * arm, an EVALUATOR carrying `outcome`/`score`, a RETRIEVER.
 */
export function contractSpan(init: ContractSpanInit): ContractSpan {
  const attributes: Record<string, unknown> = {
    ...attributeBag(init.attributes),
  };
  if (init.kind !== undefined) attributes[ATTR.spanKind] = init.kind;
  if (init.outcome !== undefined) attributes[ATTR.outcome] = init.outcome;
  if (isFiniteNumber(init.score)) attributes[ATTR.score] = init.score;

  const span: ContractSpan = {
    trace_id: init.traceId,
    span_id: init.spanId,
    parent_span_id: init.parentSpanId ?? null,
    name: init.name,
    start_time: init.startTime,
    end_time: init.endTime ?? init.startTime,
    status: init.status ?? { code: "STATUS_CODE_UNSET" },
    attributes,
  };
  if (init.kind !== undefined) span.kind = init.kind;
  if (init.links !== undefined) span.links = [...init.links];
  if (init.resource !== undefined) {
    span.resource = { attributes: { ...attributeBag(init.resource.attributes) } };
  }
  return span;
}

/** One model call. */
export interface LlmSpanInit extends SpanInit {
  /** Model slug, e.g. `'claude-opus-4'`. */
  model?: string;
  /** Provider/system, e.g. `'anthropic'` — the `gen_ai.system` convention. */
  system?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * One model call, kind `LLM`.
 *
 * Token counts and cost are omitted unless finite and non-negative: a negative
 * or `NaN` usage number is a producer bug, and writing it would poison every
 * aggregate that reads the trace. The conformance validator then reports the
 * absence, which is recoverable; a wrong number is not.
 */
export function llmSpan(init: LlmSpanInit): ContractSpan {
  const attributes: Record<string, unknown> = {
    ...attributeBag(init.attributes),
  };
  if (isNonEmptyString(init.model)) attributes[ATTR.model] = init.model;
  if (isNonEmptyString(init.system)) attributes[ATTR.system] = init.system;
  if (isUsageNumber(init.inputTokens)) {
    attributes[ATTR.inputTokens] = init.inputTokens;
  }
  if (isUsageNumber(init.outputTokens)) {
    attributes[ATTR.outputTokens] = init.outputTokens;
  }
  if (isUsageNumber(init.costUsd)) attributes[ATTR.costUsd] = init.costUsd;
  return contractSpan({ ...init, kind: "LLM", attributes });
}

/** One tool invocation. */
export interface ToolSpanInit extends SpanInit {
  toolName: string;
}

/** One tool invocation, kind `TOOL`. */
export function toolSpan(init: ToolSpanInit): ContractSpan {
  const attributes: Record<string, unknown> = {
    ...attributeBag(init.attributes),
  };
  if (isNonEmptyString(init.toolName)) {
    attributes[ATTR.toolName] = init.toolName;
  }
  return contractSpan({ ...init, kind: "TOOL", attributes });
}

/** One ITERATION of a loop — not the loop as a whole. */
export interface LoopSpanInit extends SpanInit {
  /** Stable id shared by every iteration of the same loop. */
  loopId: string;
  /** 1-based index of this iteration within `loopId`. */
  iteration: number;
  /** Budget the loop was allowed, when the producer knows it. */
  maxIterations?: number;
  /** `true` when this iteration continued from prior state rather than starting fresh. */
  resumed?: boolean;
  /** Defaults to `CHAIN`; override when an iteration is itself a whole AGENT run. */
  kind?: SpanKind;
}

/**
 * One ITERATION of a loop, kind `CHAIN` by default.
 *
 * The loop as a whole is the PARENT of these spans, not a span this builder
 * makes: iterations are what you count, compare and measure convergence over.
 * Causality to the previous iteration is a link ({@link steeredBy}), never a
 * parent edge — round N+1 is not nested inside round N.
 */
export function loopSpan(init: LoopSpanInit): ContractSpan {
  const attributes: Record<string, unknown> = {
    ...attributeBag(init.attributes),
  };
  if (isNonEmptyString(init.loopId)) attributes[ATTR.loopId] = init.loopId;
  if (isFiniteNumber(init.iteration)) {
    attributes[ATTR.iteration] = init.iteration;
  }
  if (isFiniteNumber(init.maxIterations)) {
    attributes[ATTR.maxIterations] = init.maxIterations;
  }
  if (typeof init.resumed === "boolean") {
    attributes[ATTR.resumed] = init.resumed;
  }
  return contractSpan({ ...init, kind: init.kind ?? "CHAIN", attributes });
}

/** One arm of a tree — one candidate explored in parallel with its siblings. */
export interface BranchSpanInit extends SpanInit {
  branchId: string;
  /** Id of the branch this one was forked from; omit at the root of the tree. */
  branchParentId?: string | null;
  /** Human-readable name of the arm, e.g. `'with-search'` — the comparison axis. */
  arm?: string;
  /** Defaults to `CHAIN`; override when an arm is itself a whole AGENT run. */
  kind?: SpanKind;
}

/** One arm of a tree, kind `CHAIN` by default. */
export function branchSpan(init: BranchSpanInit): ContractSpan {
  const attributes: Record<string, unknown> = {
    ...attributeBag(init.attributes),
  };
  if (isNonEmptyString(init.branchId)) {
    attributes[ATTR.branchId] = init.branchId;
  }
  if (isNonEmptyString(init.branchParentId)) {
    attributes[ATTR.branchParent] = init.branchParentId;
  }
  if (isNonEmptyString(init.arm)) attributes[ATTR.branchArm] = init.arm;
  return contractSpan({ ...init, kind: init.kind ?? "CHAIN", attributes });
}

/**
 * A causal edge to an earlier span, tagged with WHY.
 *
 * Argument order matches the OTLP link field order the caller already has to
 * hand: the span being pointed at, then the trace it lives in.
 */
export function spanLink(
  kind: LinkKind,
  priorSpanId: string,
  traceId: string,
): SpanLink {
  return {
    trace_id: traceId,
    span_id: priorSpanId,
    attributes: { [LINK_KIND_ATTR]: kind },
  };
}

/**
 * The link a loop iteration carries to the verdict that instructed it — the
 * edge that makes round-over-round convergence readable.
 */
export function steeredBy(priorSpanId: string, traceId: string): SpanLink {
  return spanLink("steered_by", priorSpanId, traceId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Usage numbers must additionally be non-negative; a negative count is a bug. */
function isUsageNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}
