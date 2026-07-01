// GenAI semantic-convention span attribute vocabulary (shared writer keys +
// reader candidate lists), so trace producers and the ingest reader can never
// drift on how model / token / cost attribution is keyed.

// Content-key alias vocabulary (shared writer keys + per-field reader candidate
// lists + log-record content-bag helper), so trace producers and the ingest
// reader can never drift on where a turn's prompt / completion / tool content
// is keyed. The content sibling of the GenAI model/token vocabulary above.
export {
  asContentField,
  asContentString,
  CONTENT_COMPLETION_KEY,
  CONTENT_KEY_FIELD,
  CONTENT_KEYS,
  CONTENT_PROMPT_KEY,
  CONTENT_TOOL_ARGS_KEY,
  CONTENT_TOOL_NAME_KEY,
  CONTENT_TOOL_RESULT_KEY,
  type ContentField,
  classifyAgent,
  type DeclaredIntentMatch,
  declaredTaskText,
  extractContent,
  hasContent,
  INDEXED_CONTENT_KEY_LIKE_PATTERNS,
  logRecordContentBag,
  type NormalizedContent,
  normalizeContentAttributes,
  resolveDeclaredIntent,
} from "./content-attributes.js";
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
// Spine run/subject/tree + trigger span-attribute vocabulary (shared writer
// PRIMARY keys + frozen reader CANDIDATE lists), so the platform workflow-trace
// emitter (writer) and intelligence-api's run-attrs derivers + reconstruct
// (readers) can never drift on how a run / parent / kind / trigger / subject is
// keyed. The run/tree sibling of the GenAI + content vocabularies above; the
// derivation LOGIC stays in intelligence-api's run-attrs.ts.
export {
  PARENT_RUN_KEY_ATTRS,
  RUN_KEY_ATTRS,
  RUN_KIND_ATTRS,
  SUBJECT_KEY_ATTRS,
  TANGLE_RUN_ID_CAMEL_KEY,
  TANGLE_RUN_ID_KEY,
  TANGLE_RUN_KIND_KEY,
  TANGLE_RUN_PARENT_ID_KEY,
  TANGLE_SUBJECT_KEY,
  TANGLE_TRIGGER_ID_KEY,
  TANGLE_TRIGGER_KIND_KEY,
  TANGLE_TRIGGER_SOURCE_KEY,
  TANGLE_WORKFLOW_ID_KEY,
  TRIGGER_ID_ATTRS,
  TRIGGER_SOURCE_ATTRS,
  WORKFLOW_MARKER_ATTRS,
} from "./spine-attributes.js";
// Producer-supplied `tokenUsage` bag field-name candidates (shared so every
// reader keys off the identical set).
export {
  addTokenUsage,
  firstTokenCount,
  firstUsageCostUsd,
  readTokenCostUsd,
  readTokenUsage,
  TOKEN_USAGE_COST_KEYS,
  TOKEN_USAGE_INPUT_KEYS,
  TOKEN_USAGE_OUTPUT_KEYS,
  type TokenUsageCounts,
  tokenCount,
  tokenUsageSource,
} from "./token-usage.js";
