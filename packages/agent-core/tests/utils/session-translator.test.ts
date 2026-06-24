import { describe, expect, it } from "vitest";
import {
  createSessionTranslator,
  type SessionTranslation,
  translateSessionId,
} from "../../src/utils/session-translator.js";

describe("session-translator", () => {
  describe("translateSessionId", () => {
    const translation: SessionTranslation = {
      from: "sidecar-uuid-123",
      to: "chat-abc",
    };

    it("translates session ID in simple object", () => {
      const event = {
        sessionId: "sidecar-uuid-123",
        type: "message",
      };

      const result = translateSessionId(event, translation);

      expect(result.sessionId).toBe("chat-abc");
      expect(result.type).toBe("message");
    });

    it("translates session ID in nested objects", () => {
      const event = {
        data: {
          session: {
            id: "sidecar-uuid-123",
          },
        },
      };

      const result = translateSessionId(event, translation);

      expect(result.data.session.id).toBe("chat-abc");
    });

    it("translates multiple occurrences of session ID", () => {
      const event = {
        sessionId: "sidecar-uuid-123",
        metadata: {
          originSession: "sidecar-uuid-123",
        },
      };

      const result = translateSessionId(event, translation);

      expect(result.sessionId).toBe("chat-abc");
      expect(result.metadata.originSession).toBe("chat-abc");
    });

    it("translates session ID in arrays", () => {
      const event = {
        sessions: ["sidecar-uuid-123", "other-session"],
      };

      const result = translateSessionId(event, translation);

      expect(result.sessions[0]).toBe("chat-abc");
      expect(result.sessions[1]).toBe("other-session");
    });

    it("returns original when no match found", () => {
      const event = {
        sessionId: "different-session",
        type: "message",
      };

      const result = translateSessionId(event, translation);

      expect(result.sessionId).toBe("different-session");
      expect(result).toEqual(event);
    });

    it("returns original for null input", () => {
      const result = translateSessionId(null, translation);
      expect(result).toBeNull();
    });

    it("returns original for undefined input", () => {
      const result = translateSessionId(undefined, translation);
      expect(result).toBeUndefined();
    });

    it("returns original for primitive inputs", () => {
      expect(translateSessionId("string", translation)).toBe("string");
      expect(translateSessionId(123, translation)).toBe(123);
      expect(translateSessionId(true, translation)).toBe(true);
    });

    it("skips translation when from equals to", () => {
      const sameTranslation: SessionTranslation = {
        from: "session-123",
        to: "session-123",
      };

      const event = { sessionId: "session-123" };
      const result = translateSessionId(event, sameTranslation);

      // Should return same reference (no processing)
      expect(result).toBe(event);
    });

    it("skips translation when from is empty", () => {
      const emptyTranslation: SessionTranslation = {
        from: "",
        to: "chat-abc",
      };

      const event = { sessionId: "session-123" };
      const result = translateSessionId(event, emptyTranslation);

      expect(result).toBe(event);
    });

    it("handles special regex characters in session IDs", () => {
      const specialTranslation: SessionTranslation = {
        from: "session.with[special]chars",
        to: "safe-session",
      };

      const event = {
        id: "session.with[special]chars",
      };

      const result = translateSessionId(event, specialTranslation);

      expect(result.id).toBe("safe-session");
    });

    it("preserves object structure and types", () => {
      const event = {
        sessionId: "sidecar-uuid-123",
        count: 42,
        active: true,
        tags: ["a", "b"],
        nested: { value: 3.14 },
      };

      const result = translateSessionId(event, translation);

      expect(result.sessionId).toBe("chat-abc");
      expect(result.count).toBe(42);
      expect(result.active).toBe(true);
      expect(result.tags).toEqual(["a", "b"]);
      expect(result.nested.value).toBe(3.14);
    });
  });

  describe("createSessionTranslator", () => {
    it("creates a reusable translator function", () => {
      const translate = createSessionTranslator({
        from: "sidecar-123",
        to: "chat-abc",
      });

      const event1 = { sessionId: "sidecar-123" };
      const event2 = { sessionId: "sidecar-123", type: "other" };

      expect(translate(event1).sessionId).toBe("chat-abc");
      expect(translate(event2).sessionId).toBe("chat-abc");
    });

    it("handles empty from with identity function", () => {
      const translate = createSessionTranslator({
        from: "",
        to: "chat-abc",
      });

      const event = { sessionId: "anything" };
      expect(translate(event)).toBe(event);
    });
  });
});
