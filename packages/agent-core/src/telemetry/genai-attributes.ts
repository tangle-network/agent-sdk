/**
 * OpenTelemetry GenAI semantic-convention span attributes — the single
 * vocabulary every trace producer in the stack emits and the intelligence
 * ingest reads, so model / token / cost attribution is identical regardless of
 * which producer lowered the span (workflow emitter, SDK trace sink, …).
 *
 * Writers emit the PRIMARY keys (`GEN_AI_*`). The ingest reader accepts the
 * wider candidate lists (`GEN_AI_*_KEYS`) because foreign SDKs spell the same
 * field differently (Langfuse, raw OTLP GenAI, our own legacy `model`).
 * Co-locating writer keys and reader candidates here is the drift guard: a
 * writer's key and the reader's first candidate can never silently disagree.
 *
 * Spec: OpenTelemetry GenAI semantic conventions (`gen_ai.*`).
 */

/** Model that served a request — the primary key writers emit. */
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
/** Model named on a response — a reader fallback; writers prefer request.model. */
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
/** Prompt / input token count. */
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
/** Completion / output token count. */
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
/** Operation name (e.g. `"invoke_agent"`). */
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
/** Conversation / session id grouping a multi-turn agent run. */
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";

/**
 * Reader candidate keys for the model, highest priority first. The first entry
 * is the writers' primary key; the rest accept foreign-SDK spellings.
 */
export const GEN_AI_MODEL_KEYS: readonly string[] = Object.freeze([
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  "llm.model_name",
  "model",
]);

/** Reader candidate keys for input tokens, highest priority first. These name
 *  SPAN ATTRIBUTES on a lowered span — for the raw producer `tokenUsage` OBJECT
 *  field names (a distinct layer) see `TOKEN_USAGE_INPUT_KEYS` in
 *  `token-usage.ts`; a new producer shape may need an entry in both. */
export const GEN_AI_INPUT_TOKEN_KEYS: readonly string[] = Object.freeze([
  GEN_AI_USAGE_INPUT_TOKENS,
  "gen_ai.usage.prompt_tokens",
  "llm.token_count.prompt",
]);

/** Reader candidate keys for output tokens, highest priority first. */
export const GEN_AI_OUTPUT_TOKEN_KEYS: readonly string[] = Object.freeze([
  GEN_AI_USAGE_OUTPUT_TOKENS,
  "gen_ai.usage.completion_tokens",
  "llm.token_count.completion",
]);

/** A model/token usage record to lower into the GenAI attribute bag. */
export interface GenAiUsage {
  /** Model slug; omitted from the attribute bag when absent or empty. */
  model?: string;
  /** Prompt tokens; omitted unless a finite, non-negative number. */
  inputTokens?: number;
  /** Completion tokens; omitted unless a finite, non-negative number. */
  outputTokens?: number;
}

function isNonNegativeFinite(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Lower a usage record to the GenAI semantic-convention attribute bag, OMITTING
 * any unknown field. A synthesized zero token count or empty model would
 * corrupt every downstream token/cost aggregate, so absent stays absent — the
 * ingest then reads "cost not computed", never "free". This is the writer-side
 * mirror of {@link GEN_AI_MODEL_KEYS} / the `*_TOKEN_KEYS` reader candidates.
 */
export function genAiUsageAttributes(
  usage: GenAiUsage,
): Record<string, string | number> {
  const attrs: Record<string, string | number> = {};
  if (typeof usage.model === "string" && usage.model.length > 0) {
    attrs[GEN_AI_REQUEST_MODEL] = usage.model;
  }
  if (isNonNegativeFinite(usage.inputTokens)) {
    attrs[GEN_AI_USAGE_INPUT_TOKENS] = usage.inputTokens;
  }
  if (isNonNegativeFinite(usage.outputTokens)) {
    attrs[GEN_AI_USAGE_OUTPUT_TOKENS] = usage.outputTokens;
  }
  return attrs;
}
