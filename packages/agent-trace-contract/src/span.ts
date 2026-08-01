/**
 * The wire shape every agent trace in this stack is emitted in and read from: a
 * plain OTLP span, plus the two edges an agent loop actually has — CONTAINMENT
 * (`parent_span_id`) and CAUSALITY (`links`).
 *
 * This module is types and one version constant. It has no runtime behaviour and
 * no dependencies, because both the emitters and the analyzer import it: a
 * contract that pulls in a judge, an analytics engine or an OTel SDK stops being
 * a contract. This is the `api` half of the api/sdk split OpenTelemetry itself
 * makes.
 */

/**
 * Which release of this package a producer emitted against, stamped into an
 * export so a consumer reading it years later can look the shape up instead of
 * guessing at it.
 *
 * It is EQUAL to the npm version of `@tangle-network/agent-trace-contract`, and
 * a test asserts that equality against `package.json`, so bumping one without
 * the other fails the suite. A second version number that moves on its own
 * rules is worse than none: it names no published artifact, and a reader who
 * trusts it cannot get back to the code that produced their spans.
 */
export const TRACE_CONTRACT_VERSION = "1.0.2";

/**
 * OpenInference span kinds, carried both as the optional `kind` field and as the
 * {@link ATTR.spanKind} attribute so a consumer that only reads attributes still
 * sees it.
 *
 * `UNKNOWN` is a real, emittable value, not an error: a producer that genuinely
 * cannot classify a span should say so rather than guess, because a wrong `LLM`
 * silently corrupts token and cost breakdowns.
 */
export type SpanKind =
  | "AGENT"
  | "CHAIN"
  | "LLM"
  | "TOOL"
  | "EVALUATOR"
  | "RETRIEVER"
  | "UNKNOWN";

/** Every {@link SpanKind}, in declaration order — for validation and iteration. */
export const SPAN_KINDS: readonly SpanKind[] = Object.freeze([
  "AGENT",
  "CHAIN",
  "LLM",
  "TOOL",
  "EVALUATOR",
  "RETRIEVER",
  "UNKNOWN",
]);

/** OTLP status codes, spelled exactly as the OTLP JSON encoding spells them. */
export type SpanStatusCode =
  | "STATUS_CODE_UNSET"
  | "STATUS_CODE_OK"
  | "STATUS_CODE_ERROR";

/** Every {@link SpanStatusCode}, for validation. */
export const SPAN_STATUS_CODES: readonly SpanStatusCode[] = Object.freeze([
  "STATUS_CODE_UNSET",
  "STATUS_CODE_OK",
  "STATUS_CODE_ERROR",
]);

/** OTLP span status. `message` carries the failure text when the code is ERROR. */
export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

/**
 * A causal edge that is NOT containment. OTLP has links and most agent tracing
 * consumers drop them, which is why loop causality — round N's grade CAUSING
 * round N+1's instruction — usually ends up encoded as a parent edge, which is a
 * lie about nesting. Round N+1 is not inside round N; it was caused by it.
 *
 * @see steeredBy
 */
export interface SpanLink {
  trace_id: string;
  span_id: string;
  /** e.g. `{ 'agent.link.kind': 'steered_by' }` — see {@link LINK_KIND_ATTR}. */
  attributes?: Record<string, unknown>;
}

/**
 * One OTLP span.
 *
 * Field names are snake_case because that is the OTLP JSON encoding; a producer
 * can hand this object straight to an OTLP/HTTP collector without a translation
 * layer, and the translation layer is exactly where vocabularies drift.
 */
export interface ContractSpan {
  trace_id: string;
  span_id: string;
  /** `null` for a root span. A non-null id MUST resolve to a span in the same export. */
  parent_span_id: string | null;
  name: string;
  kind?: SpanKind;
  /** ISO 8601. */
  start_time: string;
  /** ISO 8601; equals `start_time` for instantaneous events. */
  end_time: string;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  links?: SpanLink[];
  resource?: { attributes: Record<string, unknown> };
}

/** Terminal verdict for a graded unit of work — the value of {@link ATTR.outcome}. */
export type Outcome = "pass" | "fail" | "error";

/** Every {@link Outcome}, for validation. */
export const OUTCOMES: readonly Outcome[] = Object.freeze([
  "pass",
  "fail",
  "error",
]);
