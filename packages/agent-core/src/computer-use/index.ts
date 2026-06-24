/**
 * Computer-use action schema, validator, and provider translators.
 *
 * Single source of truth shared by the sidecar runtime, MCP server,
 * provider packages, and platform routes that dispatch computer-use
 * tool calls. Keeping action shapes here prevents drift between the
 * three layers that previously each maintained their own copy.
 */

export {
  ComputerActionTranslationError,
  type ComputerUseAction,
  type ComputerUseActionType,
  ComputerUseError,
  type MouseButton,
  normalizeKey,
  parseAction,
} from "./action.js";

export {
  type AnthropicComputerInput,
  translateAnthropicComputerAction,
} from "./anthropic.js";

export {
  type OpenAIComputerInput,
  translateOpenAIComputerAction,
} from "./openai.js";
