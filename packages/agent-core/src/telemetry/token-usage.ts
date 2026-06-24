/**
 * Candidate field names for a producer-supplied `tokenUsage` bag on a
 * `message.updated` trace event. Agents and SDK layers disagree on the
 * spelling: `StreamTokenUsage` emits `inputTokens`/`outputTokens`, the eval and
 * workflow agent.run paths emit `input`/`output`, and persisted / foreign
 * shapes use snake_case or prompt/completion naming. A reader that wants the
 * token counts must try all of them, highest-priority first, or it silently
 * drops usage for the producers it does not name.
 *
 * Shared so every `tokenUsage` reader (the trace sink's root-span aggregation,
 * the signal extractor) keys off the identical set and cannot drift.
 *
 * Distinct layer from `genai-attributes.ts`: those keys (`GEN_AI_*_TOKEN_KEYS`)
 * name OTel SPAN ATTRIBUTES on an already-lowered span; these name the fields of
 * the raw producer `tokenUsage` OBJECT before lowering. A new producer that
 * spells token usage differently may need an entry in BOTH places.
 */
export const TOKEN_USAGE_INPUT_KEYS: readonly string[] = Object.freeze([
  "inputTokens",
  "input",
  "input_tokens",
  "promptTokens",
  "prompt_tokens",
]);

export const TOKEN_USAGE_OUTPUT_KEYS: readonly string[] = Object.freeze([
  "outputTokens",
  "output",
  "output_tokens",
  "completionTokens",
  "completion_tokens",
]);
