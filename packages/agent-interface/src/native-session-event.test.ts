import { describe, expect, it } from "vitest";
import { CanonicalStreamEventSchema, NativeSessionObservedEventSchema, type StreamEvent } from "./index.js";

describe("provider-native identity observation", () => {
  const event = { type: "native.session.observed", provider: "claude-code", nativeSessionId: "provider-conversation" } as const;
  it("preserves a separate canonical control event", () => {
    const typed: StreamEvent = event;
    expect(NativeSessionObservedEventSchema.parse(typed)).toEqual(event);
    expect(CanonicalStreamEventSchema.parse(typed)).toEqual(event);
    expect(CanonicalStreamEventSchema.parse({ type: "session.updated", sessionId: "caller-resume" })).toEqual({ type: "session.updated", sessionId: "caller-resume" });
  });
  it.each([
    { ...event, provider: "" },
    { ...event, nativeSessionId: "" },
    { ...event, nativeSessionId: " padded" },
    { ...event, nativeSessionId: "a".repeat(513) },
    { ...event, sessionId: "caller-resume" },
    { type: "session.updated", sessionId: "caller-resume" },
  ])("rejects malformed or ambiguous observations %#", (input) => {
    expect(NativeSessionObservedEventSchema.safeParse(input).success).toBe(false);
  });
});
