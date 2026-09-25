/**
 * Deciding what a span IS.
 *
 * A conforming producer declares the kind, and a declared kind always wins. But
 * the point of this package is to read traces from systems that never heard of
 * it, so an undeclared span is classified from, in order: a tool-name
 * attribute, the OpenTelemetry GenAI `gen_ai.operation.name`, then model/token
 * attributes and LLM-looking names.
 *
 * The operation name is read BEFORE model and tokens because an agent or
 * workflow span routinely carries the token total of every model call beneath
 * it. Reading that span as an LLM call counts the same tokens twice. A real
 * agent-runtime export measured 3.00x its provider-reported tokens that way
 * (README, "GenAI operation mapping").
 *
 * Inference is deliberately conservative: everything unrecognised is `UNKNOWN`,
 * never a guessed `LLM`, because a wrongly-typed span silently changes token and
 * cost breakdowns while looking perfectly healthy.
 */

import {
  attributeBag,
  firstNumberAttr,
  firstStringAttr,
  INPUT_TOKEN_ATTR_KEYS,
  MODEL_ATTR_KEYS,
  OPERATION_NAME_ATTR,
  OUTPUT_TOKEN_ATTR_KEYS,
  readProperty,
  SPAN_KIND_ATTR_KEYS,
  TOOL_NAME_ATTR_KEYS,
} from "./attributes.js";
import { type SpanKind, SPAN_KINDS } from "./span.js";

const KIND_BY_NAME = new Map<string, SpanKind>(
  SPAN_KINDS.map((kind) => [kind, kind]),
);

const TOOL_NAME_PATTERN = /^(?:function|tool)[.:/]/i;
const LLM_NAME_PATTERN =
  /(?:^|[.:/_-])(?:chat[._-]?completions?|llm)(?:$|[.:/_-])/i;

/**
 * The OpenTelemetry GenAI semantic-conventions release the operation mapping is
 * pinned to. v1.41.0 is the last release that carried the GenAI registry; v1.42.0
 * moved it to `open-telemetry/semantic-conventions-genai`, which has no release
 * yet. An operation name added after this pin maps to `UNKNOWN` with loss
 * `unsupported` until the pin moves.
 */
export const GEN_AI_SEMCONV_VERSION = "1.41.0";

/**
 * What mapping an operation onto a contract kind loses.
 *
 * - `none` — the kind says everything the operation said.
 * - `kind-degraded` — the contract has no kind for the operation, so the span
 *   reads as the nearest kind and `lost` says what that costs.
 * - `unsupported` — the operation is not in the pinned semconv release.
 */
export type MappingLoss = "none" | "kind-degraded" | "unsupported";

/** One row of the published operation mapping. */
export interface GenAiOperationMapping {
  operation: string;
  kind: SpanKind;
  loss: MappingLoss;
  /** What a reader of the contract kind can no longer tell. Present unless `loss` is `none`. */
  lost?: string;
}

/**
 * Every `gen_ai.operation.name` value in semconv {@link GEN_AI_SEMCONV_VERSION}
 * and the contract kind it maps to. The README renders this table.
 */
export const GEN_AI_OPERATION_MAPPINGS: readonly GenAiOperationMapping[] =
  Object.freeze(
    [
      { operation: "chat", kind: "LLM", loss: "none" },
      { operation: "generate_content", kind: "LLM", loss: "none" },
      { operation: "text_completion", kind: "LLM", loss: "none" },
      { operation: "execute_tool", kind: "TOOL", loss: "none" },
      { operation: "invoke_agent", kind: "AGENT", loss: "none" },
      {
        operation: "create_agent",
        kind: "AGENT",
        loss: "kind-degraded",
        lost: "creating an agent reads as running one",
      },
      {
        operation: "invoke_workflow",
        kind: "CHAIN",
        loss: "kind-degraded",
        lost: "the contract has no workflow kind, so the workflow reads as one CHAIN step",
      },
      { operation: "retrieval", kind: "RETRIEVER", loss: "none" },
      { operation: "embeddings", kind: "EMBEDDING", loss: "none" },
    ].map((row) => Object.freeze(row as GenAiOperationMapping)),
  );

const MAPPING_BY_OPERATION = new Map(
  GEN_AI_OPERATION_MAPPINGS.map((row) => [row.operation, row]),
);

/** What a producer DECLARED, and whether the contract recognises it. */
export interface DeclaredSpanKind {
  /** The raw declared value, from the `kind` field or the span-kind attribute; `null` if none. */
  raw: string | null;
  /** The declared value mapped into the contract vocabulary; `null` when unrecognised. */
  kind: SpanKind | null;
}

/**
 * OTLP's own span kind (client, server, internal...), which OTLP JSON and most
 * row flatteners write into the same `kind` field. It says where a span sits on
 * the wire, not what it is, so it never counts as a declaration.
 */
const OTLP_SPAN_KIND = /^(?:SPAN_KIND_)?(?:UNSPECIFIED|INTERNAL|SERVER|CLIENT|PRODUCER|CONSUMER)$/i;

/**
 * Read the declared kind without inferring anything. `raw` non-null with `kind`
 * null is the interesting case: the producer said something, and it is not a
 * word this contract knows.
 *
 * A recognised `kind` field wins, then the span-kind attribute, then an
 * unrecognised `kind` field. An OTLP span kind in the `kind` field is skipped,
 * so a flattened OTLP row still yields its `openinference.span.kind`.
 */
export function declaredSpanKind(span: unknown): DeclaredSpanKind {
  if (span === null || typeof span !== "object") return { raw: null, kind: null };
  const field = readProperty(span, "kind");
  const fieldValue =
    typeof field === "string" && field.length > 0 && !OTLP_SPAN_KIND.test(field)
      ? field
      : undefined;
  const fieldKind = fieldValue === undefined ? undefined : KIND_BY_NAME.get(fieldValue.toUpperCase());
  if (fieldValue !== undefined && fieldKind !== undefined) return { raw: fieldValue, kind: fieldKind };
  const attribute = firstStringAttr(
    attributeBag(readProperty(span, "attributes")),
    SPAN_KIND_ATTR_KEYS,
  );
  const declared = attribute ?? fieldValue;
  if (declared === undefined) return { raw: null, kind: null };
  return { raw: declared, kind: KIND_BY_NAME.get(declared.toUpperCase()) ?? null };
}

/** A span's kind, plus what the operation mapping lost when one decided it. */
export interface SpanClassification {
  kind: SpanKind;
  /**
   * Set when an undeclared span's kind came from a `gen_ai.operation.name` that
   * maps with loss. A declared kind never carries one: the producer chose it.
   */
  operationLoss?: GenAiOperationMapping;
}

/**
 * Classify a span: declared if recognised, else inferred, else `UNKNOWN`, with
 * the operation-mapping loss when the operation name decided it. Never throws,
 * on any input.
 */
export function classifySpan(span: unknown): SpanClassification {
  if (span === null || typeof span !== "object") return { kind: "UNKNOWN" };
  const declared = declaredSpanKind(span);
  if (declared.kind !== null) return { kind: declared.kind };

  const attributes = attributeBag(readProperty(span, "attributes"));
  const rawName = readProperty(span, "name");
  const name = typeof rawName === "string" ? rawName : "";

  if (
    firstStringAttr(attributes, TOOL_NAME_ATTR_KEYS) !== undefined ||
    TOOL_NAME_PATTERN.test(name)
  ) {
    return { kind: "TOOL" };
  }

  const operation = firstStringAttr(attributes, [OPERATION_NAME_ATTR]);
  if (operation !== undefined) {
    const mapping = MAPPING_BY_OPERATION.get(operation) ?? {
      operation,
      kind: "UNKNOWN",
      loss: "unsupported",
      lost: `semconv ${GEN_AI_SEMCONV_VERSION} does not define this operation`,
    };
    return mapping.loss === "none"
      ? { kind: mapping.kind }
      : { kind: mapping.kind, operationLoss: mapping };
  }

  if (
    firstStringAttr(attributes, MODEL_ATTR_KEYS) !== undefined ||
    firstNumberAttr(attributes, INPUT_TOKEN_ATTR_KEYS) !== undefined ||
    firstNumberAttr(attributes, OUTPUT_TOKEN_ATTR_KEYS) !== undefined ||
    LLM_NAME_PATTERN.test(name)
  ) {
    return { kind: "LLM" };
  }

  return { kind: "UNKNOWN" };
}

/**
 * The kind to analyse a span as. The same answer as {@link classifySpan}
 * without the loss detail. Never throws, on any input.
 */
export function resolveSpanKind(span: unknown): SpanKind {
  return classifySpan(span).kind;
}
