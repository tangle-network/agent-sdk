/**
 * Session ID Translator
 *
 * Generic utility for translating session IDs in event objects.
 * Used to map internal session IDs to client-facing session IDs.
 */

export interface SessionTranslation {
  /** The internal session ID to replace */
  from: string;
  /** The client-facing session ID to use */
  to: string;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate session IDs in an event object.
 * Performs a deep string replacement via JSON serialization.
 *
 * @param event - The event object to translate
 * @param translation - The session ID mapping
 * @returns A new event object with translated session IDs
 */
export function translateSessionId<T>(
  event: T,
  translation: SessionTranslation,
): T {
  if (!event || typeof event !== "object") {
    return event;
  }

  // Skip if from/to are the same
  if (translation.from === translation.to) {
    return event;
  }

  // Skip if from is empty
  if (!translation.from) {
    return event;
  }

  try {
    const json = JSON.stringify(event);

    // Use global replace to handle multiple occurrences
    const pattern = new RegExp(escapeRegex(translation.from), "g");
    const translated = json.replace(pattern, translation.to);

    // Only parse if we actually made changes
    if (translated !== json) {
      return JSON.parse(translated);
    }

    return event;
  } catch {
    // If serialization fails, return original
    return event;
  }
}

/**
 * Create a reusable translator function for a specific session mapping.
 * Pre-compiles the regex pattern for better performance when translating
 * many events with the same mapping.
 */
export function createSessionTranslator(
  translation: SessionTranslation,
): <T>(event: T) => T {
  // Pre-compile the regex for performance
  const pattern = new RegExp(escapeRegex(translation.from), "g");

  return <T>(event: T): T => {
    if (!event || typeof event !== "object") {
      return event;
    }

    if (translation.from === translation.to || !translation.from) {
      return event;
    }

    try {
      const json = JSON.stringify(event);
      const translated = json.replace(pattern, translation.to);

      if (translated !== json) {
        return JSON.parse(translated);
      }

      return event;
    } catch {
      return event;
    }
  };
}

/**
 * Extract session ID from various event structures.
 * Handles different event formats that may contain session information.
 */
export function extractSessionId(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const obj = event as Record<string, unknown>;

  // Direct sessionId field
  if (typeof obj.sessionId === "string") {
    return obj.sessionId;
  }

  // Nested in properties
  if (obj.properties && typeof obj.properties === "object") {
    const props = obj.properties as Record<string, unknown>;
    if (typeof props.sessionId === "string") {
      return props.sessionId;
    }
  }

  // Nested in data
  if (obj.data && typeof obj.data === "object") {
    const data = obj.data as Record<string, unknown>;
    if (typeof data.sessionId === "string") {
      return data.sessionId;
    }
  }

  return null;
}
