// GenAI semantic-convention span attribute vocabulary (shared writer keys +
// reader candidate lists), so trace producers and the ingest reader can never
// drift on how model / token / cost attribution is keyed.
export {
  GEN_AI_CONVERSATION_ID,
  GEN_AI_INPUT_TOKEN_KEYS,
  GEN_AI_MODEL_KEYS,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_TOKEN_KEYS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  type GenAiUsage,
  genAiUsageAttributes,
} from "./genai-attributes.js";
// Producer-supplied `tokenUsage` bag field-name candidates (shared so every
// reader keys off the identical set).
export {
  TOKEN_USAGE_INPUT_KEYS,
  TOKEN_USAGE_OUTPUT_KEYS,
} from "./token-usage.js";
