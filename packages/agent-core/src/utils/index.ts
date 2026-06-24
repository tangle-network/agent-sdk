/**
 * Generic Utilities
 *
 * Transport-agnostic utility functions for session management
 * and channel pattern matching.
 */

export {
  matchesAnyChannel,
  matchesChannel,
} from "./channel-matching.js";

export {
  createSessionTranslator,
  extractSessionId,
  type SessionTranslation,
  translateSessionId,
} from "./session-translator.js";
