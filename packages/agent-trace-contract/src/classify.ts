/**
 * Deciding what a span IS.
 *
 * A conforming producer declares the kind, and a declared kind always wins. But
 * the point of this package is to read traces from systems that never heard of
 * it, so an undeclared span is classified from the same signals
 * `@tangle-network/agent-eval` uses — tool-name attribute, model/token
 * attributes, and the operation-name conventions — which keeps the two
 * classifiers agreeing on a foreign trace instead of producing two different
 * tool counts for the same file.
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

/** What a producer DECLARED, and whether the contract recognises it. */
export interface DeclaredSpanKind {
  /** The raw declared value, from the `kind` field or the span-kind attribute; `null` if none. */
  raw: string | null;
  /** The declared value mapped into the contract vocabulary; `null` when unrecognised. */
  kind: SpanKind | null;
}

/**
 * Read the declared kind without inferring anything. `raw` non-null with `kind`
 * null is the interesting case: the producer said something, and it is not a
 * word this contract knows.
 */
export function declaredSpanKind(span: unknown): DeclaredSpanKind {
  if (span === null || typeof span !== "object") return { raw: null, kind: null };
  const attributes = attributeBag(readProperty(span, "attributes"));
  const kind = readProperty(span, "kind");
  const declared =
    typeof kind === "string" && kind.length > 0
      ? kind
      : firstStringAttr(attributes, SPAN_KIND_ATTR_KEYS);
  if (declared === undefined) return { raw: null, kind: null };
  return { raw: declared, kind: KIND_BY_NAME.get(declared.toUpperCase()) ?? null };
}

/**
 * The kind to analyse a span as: declared if recognised, else inferred from its
 * attributes and name, else `UNKNOWN`. Never throws, on any input.
 */
export function resolveSpanKind(span: unknown): SpanKind {
  if (span === null || typeof span !== "object") return "UNKNOWN";
  const declared = declaredSpanKind(span);
  if (declared.kind !== null) return declared.kind;

  const attributes = attributeBag(readProperty(span, "attributes"));
  const rawName = readProperty(span, "name");
  const name = typeof rawName === "string" ? rawName : "";

  if (
    firstStringAttr(attributes, TOOL_NAME_ATTR_KEYS) !== undefined ||
    TOOL_NAME_PATTERN.test(name)
  ) {
    return "TOOL";
  }

  if (
    firstStringAttr(attributes, MODEL_ATTR_KEYS) !== undefined ||
    firstNumberAttr(attributes, INPUT_TOKEN_ATTR_KEYS) !== undefined ||
    firstNumberAttr(attributes, OUTPUT_TOKEN_ATTR_KEYS) !== undefined ||
    typeof readProperty(attributes, "gen_ai.operation.name") === "string" ||
    LLM_NAME_PATTERN.test(name)
  ) {
    return "LLM";
  }

  return "UNKNOWN";
}
