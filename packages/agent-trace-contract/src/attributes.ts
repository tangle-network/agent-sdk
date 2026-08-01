/**
 * The attribute vocabulary. One rule decides every key here: **use the standard
 * name wherever a standard exists**, and namespace under `agent.*` only where no
 * standard does.
 *
 * So model, tokens, cost and tool name are OpenTelemetry `gen_ai.*` semantic
 * conventions, span kind is OpenInference's, and loops / branches / outcome are
 * ours, because no semantic convention describes an agent that grades itself and
 * runs again. Inventing a `tangle.model` when `gen_ai.request.model` exists is
 * how a trace becomes readable only by the tool that wrote it.
 *
 * WRITERS emit the primary key ({@link ATTR}). READERS should use the candidate
 * lists (`*_ATTR_KEYS`), which additionally accept the spellings foreign SDKs
 * use for the same field, so a trace from Langfuse, OpenInference or an older
 * producer still yields token and cost numbers. `@tangle-network/agent-eval`
 * reads the same candidate sets; the one ordering difference is deliberate and
 * noted on {@link MODEL_ATTR_KEYS}.
 */

/**
 * The primary keys a conforming producer writes.
 *
 * A key is absent, never zero or empty: a synthesized `0` token count or `""`
 * model corrupts every downstream sum, and the consumer then reads "free"
 * instead of "not measured".
 *
 * Frozen, because `as const` is a compile-time claim only and this object is
 * shared by every producer in a process: one JavaScript consumer reassigning a
 * key would silently re-vocabulary everything emitted afterwards.
 */
export const ATTR = Object.freeze({
  spanKind: "openinference.span.kind",
  // gen_ai semantic conventions — use the STANDARD name wherever one exists
  model: "gen_ai.request.model",
  system: "gen_ai.system",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  costUsd: "gen_ai.usage.cost_usd",
  toolName: "gen_ai.tool.name",
  // loops — no semconv equivalent exists, so these are ours and namespaced
  loopId: "agent.loop.id",
  iteration: "agent.loop.iteration",
  maxIterations: "agent.loop.max_iterations",
  resumed: "agent.loop.resumed",
  // trees
  branchId: "agent.branch.id",
  branchParent: "agent.branch.parent_id",
  branchArm: "agent.branch.arm",
  // outcome
  outcome: "agent.outcome",
  score: "agent.outcome.score",
} as const);

/** Any primary attribute key. */
export type AttrKey = (typeof ATTR)[keyof typeof ATTR];

/**
 * Key naming what KIND of causal edge a {@link SpanLink} is. Kept out of
 * {@link ATTR} because it is a link attribute, not a span attribute — the two
 * bags are addressed separately in OTLP and conflating them makes a reader
 * search the wrong place.
 */
export const LINK_KIND_ATTR = "agent.link.kind";

/**
 * Why one span points at another.
 *
 * - `steered_by` — this unit of work was instructed by the verdict on the target
 *   (round N+1 steered by round N's grade).
 * - `graded_by` — the target evaluated this unit of work.
 * - `retry_of` — this unit of work re-attempts the target after a failure.
 */
export type LinkKind = "steered_by" | "graded_by" | "retry_of";

/** Every {@link LinkKind}, for validation. */
export const LINK_KINDS: readonly LinkKind[] = Object.freeze([
  "steered_by",
  "graded_by",
  "retry_of",
]);

/** Span-kind reader candidates, highest priority first. */
export const SPAN_KIND_ATTR_KEYS: readonly string[] = Object.freeze([
  ATTR.spanKind,
  "inference.observation_kind",
]);

/**
 * Model reader candidates, highest priority first.
 *
 * `agent-eval` reads the same set but ranks `llm.model_name` first because its
 * own producers write that key. The order only decides which value wins when a
 * span carries two DIFFERENT model names, which a conforming producer never
 * emits; both readers accept both keys, so a contract-emitted span reads
 * correctly in `agent-eval` and vice versa.
 */
export const MODEL_ATTR_KEYS: readonly string[] = Object.freeze([
  ATTR.model,
  "gen_ai.response.model",
  "llm.model_name",
  "inference.llm.model_name",
  "llm.model",
  "model",
  "tangle.model",
]);

/** Input/prompt token reader candidates, highest priority first. */
export const INPUT_TOKEN_ATTR_KEYS: readonly string[] = Object.freeze([
  ATTR.inputTokens,
  "gen_ai.usage.prompt_tokens",
  "llm.token_count.prompt",
  "inference.llm.input_tokens",
  "llm.input_tokens",
  "tangle.tokens.in",
  "tokens.in",
]);

/** Output/completion token reader candidates, highest priority first. */
export const OUTPUT_TOKEN_ATTR_KEYS: readonly string[] = Object.freeze([
  ATTR.outputTokens,
  "gen_ai.usage.completion_tokens",
  "llm.token_count.completion",
  "inference.llm.output_tokens",
  "llm.output_tokens",
  "tangle.tokens.out",
  "tokens.out",
]);

/**
 * Cost reader candidates, highest priority first.
 *
 * A bare `cost` key is deliberately NOT accepted, though `agent-eval` accepts it
 * as a last resort: this package uses the presence of a cost key to answer
 * "can this trace be costed", and `cost` is generic enough to appear on a span
 * that means something else entirely, which would turn a false positive into a
 * confident wrong answer.
 */
export const COST_ATTR_KEYS: readonly string[] = Object.freeze([
  ATTR.costUsd,
  "gen_ai.usage.cost",
  "llm.cost_usd",
  "inference.llm.cost.total",
  "llm.cost.total",
  "tangle.cost.usd",
  "cost.usd",
]);

/**
 * Tool-name reader candidates, highest priority first. `gen_ai.tool.name` is the
 * semantic convention and therefore the contract's primary; `tool.name` is what
 * OpenInference producers write.
 */
export const TOOL_NAME_ATTR_KEYS: readonly string[] = Object.freeze([
  ATTR.toolName,
  "tool.name",
  "inference.tool.name",
]);

/**
 * Loop-iteration reader candidates. One entry: no other system has a convention
 * for this, so there is no foreign spelling to accept, and inventing aliases
 * nobody emits would only make the list look authoritative.
 */
export const ITERATION_ATTR_KEYS: readonly string[] = Object.freeze([
  ATTR.iteration,
]);

/**
 * Every key that carries branch identity — and, unlike every other list here,
 * NOT a set of alternative spellings for one field. `agent.branch.id` names the
 * arm and `agent.branch.arm` names it readably, so they are two DIMENSIONS of
 * one identity and a reader that takes the first match loses the second: two
 * sibling arms recorded under one branch id answer that id for both, and the
 * trace reads as one branch with nothing to compare. Use this list to ask "is
 * any branch signal here at all"; count the keys separately to ask how many
 * arms there are.
 */
export const BRANCH_ATTR_KEYS: readonly string[] = Object.freeze([
  ATTR.branchId,
  ATTR.branchArm,
]);

const EMPTY_ATTRIBUTES: Record<string, unknown> = Object.freeze({});

/**
 * Read one property off a value of unknown shape, treating a read that FAILS as
 * a read that found nothing.
 *
 * A property access is not a safe operation on an arbitrary object: a getter or
 * a Proxy trap can throw, and every reader in this package is pointed at objects
 * some other system built. A value that cannot be read is absent as far as any
 * consumer is concerned, so reporting it absent is what turns a crash on a
 * foreign trace into a finding about it.
 */
export function readProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Read an attribute bag off a value of unknown shape. A `null`, missing or
 * array-valued `attributes` field yields an empty bag rather than throwing,
 * because every reader in this package must survive a foreign trace.
 */
export function attributeBag(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_ATTRIBUTES;
  }
  return value as Record<string, unknown>;
}

/**
 * Is any candidate key PRESENT, whatever its value?
 *
 * The companion to {@link firstStringAttr} and {@link firstNumberAttr}, which
 * answer the different question "is there a USABLE value here". The two answers
 * diverge exactly when a producer emitted the key carrying something no reader
 * can use — `null`, `""`, `"n/a"`, an object — and that gap matters: a consumer
 * that reports such a key as missing sends the producer hunting an emit bug it
 * does not have, when the real defect is the value.
 *
 * Presence is judged through the same access path the readers use, so a key
 * explicitly set to `undefined` counts as absent — JSON cannot express it, and
 * no reader could tell it from a key that was never written.
 */
export function hasAttrKey(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  for (const key of keys) {
    if (readProperty(attributes, key) !== undefined) return true;
  }
  return false;
}

/** First non-empty string across the candidate keys; `undefined` when none match. */
export function firstStringAttr(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readProperty(attributes, key);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * First finite number across the candidate keys, tolerating numeric strings
 * because OTLP exporters that flatten attributes to strings are common.
 * `undefined` when none match.
 */
export function firstNumberAttr(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = readProperty(attributes, key);
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      continue;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
