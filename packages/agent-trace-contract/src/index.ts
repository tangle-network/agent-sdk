/**
 * `@tangle-network/agent-trace-contract` — the span contract every agent trace
 * in this stack is emitted in and read from.
 *
 * ZERO runtime dependencies, by rule: this package is imported by the producers
 * AND by the analyzer, so the moment it pulls in a judge, an analytics engine or
 * an OTel SDK, agreeing on the contract costs you a dependency tree. It is the
 * `api` half of the api/sdk split OpenTelemetry itself makes.
 */

/**
 * THE span classifier. Any consumer deciding what a span IS — an LLM call, a
 * tool call, something it cannot name — calls `resolveSpanKind` and nothing
 * else. It is exported first because reimplementing it is a data-losing bug
 * rather than a duplication smell: a second classifier that disagrees produces a
 * different tool count, a different token total and a different cost for the
 * same file, and the two numbers both look healthy. `declaredSpanKind` is the
 * companion for telling "the producer said LLM" from "we inferred LLM".
 */
export {
  declaredSpanKind,
  type DeclaredSpanKind,
  resolveSpanKind,
} from "./classify.js";
/**
 * Ids. `deriveHexId` maps a readable id onto the hex encoding OTLP and W3C
 * `traceparent` require, so two systems that never talk mint the same id for the
 * same unit of work and their spans join into one tree.
 */
export {
  deriveHexId,
  isW3CSpanId,
  isW3CTraceId,
  SPAN_ID_HEX_LENGTH,
  TRACE_ID_HEX_LENGTH,
} from "./ids.js";
export {
  ATTR,
  type AttrKey,
  attributeBag,
  BRANCH_ATTR_KEYS,
  COST_ATTR_KEYS,
  firstNumberAttr,
  firstStringAttr,
  hasAttrKey,
  INPUT_TOKEN_ATTR_KEYS,
  ITERATION_ATTR_KEYS,
  LINK_KIND_ATTR,
  LINK_KINDS,
  type LinkKind,
  MODEL_ATTR_KEYS,
  OUTPUT_TOKEN_ATTR_KEYS,
  SPAN_KIND_ATTR_KEYS,
  TOOL_NAME_ATTR_KEYS,
} from "./attributes.js";
export {
  branchSpan,
  type BranchSpanInit,
  contractSpan,
  type ContractSpanInit,
  llmSpan,
  type LlmSpanInit,
  loopSpan,
  type LoopSpanInit,
  spanLink,
  type SpanInit,
  steeredBy,
  toolSpan,
  type ToolSpanInit,
} from "./builders.js";
export {
  type ContractSpan,
  type Outcome,
  OUTCOMES,
  type SpanKind,
  SPAN_KINDS,
  type SpanLink,
  SPAN_STATUS_CODES,
  type SpanStatus,
  type SpanStatusCode,
  TRACE_CONTRACT_VERSION,
} from "./span.js";
export {
  type Capability,
  CAPABILITY_NAMES,
  type CapabilityName,
  type ConformanceFinding,
  type FindingCode,
  type FindingSeverity,
  MAX_SPANS_READ,
  type TraceValidation,
  validateTraceSpans,
} from "./validate.js";
