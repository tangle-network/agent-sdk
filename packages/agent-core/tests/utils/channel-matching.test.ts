import { describe, expect, it } from "vitest";
import {
  matchesAnyChannel,
  matchesChannel,
} from "../../src/utils/channel-matching.js";

describe("channel-matching", () => {
  describe("matchesChannel", () => {
    it("matches exact channel names", () => {
      expect(matchesChannel("message", "message")).toBe(true);
      expect(matchesChannel("agent.event", "agent.event")).toBe(true);
      expect(matchesChannel("port.opened", "port.opened")).toBe(true);
    });

    it("does not match different channel names", () => {
      expect(matchesChannel("message", "event")).toBe(false);
      expect(matchesChannel("agent.event", "agent.status")).toBe(false);
      expect(matchesChannel("port.opened", "port.closed")).toBe(false);
    });

    it("matches wildcard pattern '*' to any channel", () => {
      expect(matchesChannel("*", "message")).toBe(true);
      expect(matchesChannel("*", "agent.event")).toBe(true);
      expect(matchesChannel("*", "anything")).toBe(true);
      expect(matchesChannel("*", "")).toBe(true);
    });

    it("matches prefix wildcard patterns 'prefix.*'", () => {
      expect(matchesChannel("agent.*", "agent.event")).toBe(true);
      expect(matchesChannel("agent.*", "agent.status")).toBe(true);
      expect(matchesChannel("agent.*", "agent.error")).toBe(true);
      expect(matchesChannel("port.*", "port.opened")).toBe(true);
      expect(matchesChannel("port.*", "port.closed")).toBe(true);
    });

    it("does not match prefix pattern without dot separator", () => {
      // "agent.*" should NOT match "agent" (no dot)
      expect(matchesChannel("agent.*", "agent")).toBe(false);
      // "agent.*" should NOT match "agentfoo" (no dot)
      expect(matchesChannel("agent.*", "agentfoo")).toBe(false);
    });

    it("does not match prefix pattern to different prefixes", () => {
      expect(matchesChannel("agent.*", "message.event")).toBe(false);
      expect(matchesChannel("agent.*", "port.opened")).toBe(false);
      expect(matchesChannel("port.*", "agent.event")).toBe(false);
    });

    it("handles nested channel patterns", () => {
      expect(matchesChannel("agent.session.*", "agent.session.started")).toBe(
        true,
      );
      expect(matchesChannel("agent.session.*", "agent.session.ended")).toBe(
        true,
      );
      expect(matchesChannel("agent.session.*", "agent.event")).toBe(false);
    });

    it("handles empty strings", () => {
      expect(matchesChannel("", "")).toBe(true);
      expect(matchesChannel("", "message")).toBe(false);
      expect(matchesChannel("message", "")).toBe(false);
    });

    it("matches colon-separated wildcard patterns 'prefix:*'", () => {
      // Session channels
      expect(matchesChannel("session:*", "session:abc123")).toBe(true);
      expect(matchesChannel("session:*", "session:sess-xyz-789")).toBe(true);
      expect(matchesChannel("session:*", "session:")).toBe(false);

      // Agent channels
      expect(matchesChannel("agent:*", "agent:abc123")).toBe(true);
      expect(matchesChannel("agent:*", "agent:sess-xyz-789")).toBe(true);

      // Project channels
      expect(matchesChannel("project:*", "project:proj-a")).toBe(true);
      expect(matchesChannel("project:*", "project:proj_123")).toBe(true);
    });

    it("does not match colon pattern without colon separator", () => {
      // "session:*" should NOT match "session" (no colon)
      expect(matchesChannel("session:*", "session")).toBe(false);
      // "session:*" should NOT match "sessionfoo" (no colon)
      expect(matchesChannel("session:*", "sessionfoo")).toBe(false);
    });

    it("does not match colon pattern to different prefixes", () => {
      expect(matchesChannel("session:*", "agent:abc123")).toBe(false);
      expect(matchesChannel("session:*", "project:proj-a")).toBe(false);
      expect(matchesChannel("project:*", "session:abc123")).toBe(false);
    });

    it("matches exact colon-separated channel names", () => {
      expect(matchesChannel("session:abc", "session:abc")).toBe(true);
      expect(matchesChannel("project:proj-1", "project:proj-1")).toBe(true);
      expect(matchesChannel("session:abc", "session:xyz")).toBe(false);
    });

    it("handles channels with special characters after colon", () => {
      expect(matchesChannel("session:*", "session:sess_123-abc")).toBe(true);
      expect(matchesChannel("session:*", "session:sess.with.dots")).toBe(true);
      expect(matchesChannel("session:*", "session:sess:with:colons")).toBe(
        true,
      );
    });
  });

  describe("matchesAnyChannel", () => {
    it("returns true if any pattern matches (Set)", () => {
      const patterns = new Set(["message", "agent.*"]);
      expect(matchesAnyChannel(patterns, "message")).toBe(true);
      expect(matchesAnyChannel(patterns, "agent.event")).toBe(true);
      expect(matchesAnyChannel(patterns, "agent.status")).toBe(true);
    });

    it("returns true if any pattern matches (Array)", () => {
      const patterns = ["message", "agent.*"];
      expect(matchesAnyChannel(patterns, "message")).toBe(true);
      expect(matchesAnyChannel(patterns, "agent.event")).toBe(true);
    });

    it("returns false if no pattern matches", () => {
      const patterns = new Set(["message", "agent.*"]);
      expect(matchesAnyChannel(patterns, "port.opened")).toBe(false);
      expect(matchesAnyChannel(patterns, "unknown")).toBe(false);
    });

    it("returns true for wildcard in patterns", () => {
      const patterns = new Set(["*"]);
      expect(matchesAnyChannel(patterns, "anything")).toBe(true);
      expect(matchesAnyChannel(patterns, "message")).toBe(true);
      expect(matchesAnyChannel(patterns, "agent.event")).toBe(true);
    });

    it("handles empty pattern set", () => {
      const patterns = new Set<string>();
      expect(matchesAnyChannel(patterns, "message")).toBe(false);
    });

    it("handles empty pattern array", () => {
      const patterns: string[] = [];
      expect(matchesAnyChannel(patterns, "message")).toBe(false);
    });

    it("handles multiple wildcard patterns", () => {
      const patterns = new Set(["agent.*", "port.*", "message"]);
      expect(matchesAnyChannel(patterns, "agent.event")).toBe(true);
      expect(matchesAnyChannel(patterns, "port.opened")).toBe(true);
      expect(matchesAnyChannel(patterns, "message")).toBe(true);
      expect(matchesAnyChannel(patterns, "unknown")).toBe(false);
    });

    it("matches colon-based wildcard patterns for session/project channels", () => {
      const patterns = new Set(["session:*", "system"]);
      expect(matchesAnyChannel(patterns, "session:abc123")).toBe(true);
      expect(matchesAnyChannel(patterns, "session:sess-xyz")).toBe(true);
      expect(matchesAnyChannel(patterns, "system")).toBe(true);
      expect(matchesAnyChannel(patterns, "project:proj-a")).toBe(false);
    });

    it("handles mixed dot and colon wildcard patterns", () => {
      const patterns = new Set(["session:*", "agent:*", "system.*", "message"]);
      expect(matchesAnyChannel(patterns, "session:sess-123")).toBe(true);
      expect(matchesAnyChannel(patterns, "agent:sess-123")).toBe(true);
      expect(matchesAnyChannel(patterns, "system.heartbeat")).toBe(true);
      expect(matchesAnyChannel(patterns, "message")).toBe(true);
      expect(matchesAnyChannel(patterns, "project:proj-a")).toBe(false);
    });

    it("handles project subscriber patterns for batch tokens", () => {
      const patterns = new Set([
        "project:proj-a",
        "project:proj-b",
        "session:*",
        "agent:*",
        "*",
      ]);
      // Global wildcard matches everything
      expect(matchesAnyChannel(patterns, "session:any-session")).toBe(true);
      expect(matchesAnyChannel(patterns, "project:proj-c")).toBe(true);
      expect(matchesAnyChannel(patterns, "random-channel")).toBe(true);
    });
  });
});
