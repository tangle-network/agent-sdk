/**
 * Channel Access Control Security Tests
 *
 * Tests that token scopes correctly restrict channel access.
 * This is critical for multi-tenant security - tokens must only
 * grant access to channels they're authorized for.
 */

import { describe, expect, it } from "vitest";
import {
  canBatchTokenAccessChannel,
  canProjectTokenAccessChannel,
  canSessionTokenAccessChannel,
  canTokenAccessChannel,
  extractProjectFromChannel,
  extractSessionFromChannel,
  getAllowedChannelPatterns,
  validateChannelSubscription,
} from "../../src/auth/channel-access.js";
import type {
  BatchScopedTokenPayload,
  ProjectScopedTokenPayload,
  SessionScopedTokenPayload,
} from "../../src/auth/types.js";

// Test payloads
const sessionPayload: SessionScopedTokenPayload = {
  sub: "user_123",
  sid: "sess_abc",
  pid: "prod_test",
  typ: "read",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const projectPayload: ProjectScopedTokenPayload = {
  sub: "user_123",
  projectId: "proj_xyz",
  pid: "prod_test",
  typ: "read",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const batchPayload: BatchScopedTokenPayload = {
  sub: "user_123",
  projectIds: ["proj_one", "proj_two", "proj_three"],
  pid: "prod_test",
  typ: "read",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

describe("Channel Extraction", () => {
  describe("extractSessionFromChannel", () => {
    it("extracts session ID from session: channel", () => {
      expect(extractSessionFromChannel("session:sess_abc")).toBe("sess_abc");
    });

    it("extracts session ID from agent: channel", () => {
      expect(extractSessionFromChannel("agent:sess_abc")).toBe("sess_abc");
    });

    it("returns null for non-session channels", () => {
      expect(extractSessionFromChannel("project:proj_123")).toBeNull();
      expect(extractSessionFromChannel("system")).toBeNull();
      expect(extractSessionFromChannel("random_channel")).toBeNull();
    });
  });

  describe("extractProjectFromChannel", () => {
    it("extracts project ID from project: channel", () => {
      expect(extractProjectFromChannel("project:proj_xyz")).toBe("proj_xyz");
    });

    it("returns null for non-project channels", () => {
      expect(extractProjectFromChannel("session:sess_123")).toBeNull();
      expect(extractProjectFromChannel("system")).toBeNull();
      expect(extractProjectFromChannel("agent:sess_123")).toBeNull();
    });
  });
});

describe("Session Token Channel Access", () => {
  describe("Allowed Channels", () => {
    it("allows access to own session channel", () => {
      const result = canSessionTokenAccessChannel(
        sessionPayload,
        "session:sess_abc",
      );
      expect(result.allowed).toBe(true);
    });

    it("allows access to own agent channel", () => {
      const result = canSessionTokenAccessChannel(
        sessionPayload,
        "agent:sess_abc",
      );
      expect(result.allowed).toBe(true);
    });

    it("allows access to system channels", () => {
      expect(
        canSessionTokenAccessChannel(sessionPayload, "system").allowed,
      ).toBe(true);
      expect(
        canSessionTokenAccessChannel(sessionPayload, "system.heartbeat")
          .allowed,
      ).toBe(true);
    });
  });

  describe("Denied Channels", () => {
    it("denies access to different session", () => {
      const result = canSessionTokenAccessChannel(
        sessionPayload,
        "session:other_session",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("sess_abc");
    });

    it("denies access to wildcard sessions", () => {
      const result = canSessionTokenAccessChannel(sessionPayload, "session:*");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("all sessions");
    });

    it("denies access to global wildcard", () => {
      const result = canSessionTokenAccessChannel(sessionPayload, "*");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("all channels");
    });

    it("denies access to project channels", () => {
      const result = canSessionTokenAccessChannel(
        sessionPayload,
        "project:proj_xyz",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("project channels");
    });
  });
});

describe("Project Token Channel Access", () => {
  describe("Allowed Channels", () => {
    it("allows access to own project channel", () => {
      const result = canProjectTokenAccessChannel(
        projectPayload,
        "project:proj_xyz",
      );
      expect(result.allowed).toBe(true);
    });

    it("allows access to wildcard sessions (within project)", () => {
      expect(
        canProjectTokenAccessChannel(projectPayload, "session:*").allowed,
      ).toBe(true);
      expect(
        canProjectTokenAccessChannel(projectPayload, "agent:*").allowed,
      ).toBe(true);
    });

    it("allows access to specific session (caller must verify project)", () => {
      const result = canProjectTokenAccessChannel(
        projectPayload,
        "session:sess_123",
      );
      expect(result.allowed).toBe(true);
    });

    it("allows access to system channels", () => {
      expect(
        canProjectTokenAccessChannel(projectPayload, "system").allowed,
      ).toBe(true);
    });
  });

  describe("Denied Channels", () => {
    it("denies access to different project", () => {
      const result = canProjectTokenAccessChannel(
        projectPayload,
        "project:other_project",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("proj_xyz");
    });

    it("denies access to global wildcard", () => {
      const result = canProjectTokenAccessChannel(projectPayload, "*");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("all channels");
    });
  });
});

describe("Batch Token Channel Access", () => {
  describe("Allowed Channels", () => {
    it("allows access to any project in the batch", () => {
      expect(
        canBatchTokenAccessChannel(batchPayload, "project:proj_one").allowed,
      ).toBe(true);
      expect(
        canBatchTokenAccessChannel(batchPayload, "project:proj_two").allowed,
      ).toBe(true);
      expect(
        canBatchTokenAccessChannel(batchPayload, "project:proj_three").allowed,
      ).toBe(true);
    });

    it("allows access to wildcard project channel", () => {
      const result = canBatchTokenAccessChannel(batchPayload, "project:*");
      expect(result.allowed).toBe(true);
    });

    it("allows access to global wildcard", () => {
      const result = canBatchTokenAccessChannel(batchPayload, "*");
      expect(result.allowed).toBe(true);
    });

    it("allows access to wildcard sessions", () => {
      expect(
        canBatchTokenAccessChannel(batchPayload, "session:*").allowed,
      ).toBe(true);
      expect(canBatchTokenAccessChannel(batchPayload, "agent:*").allowed).toBe(
        true,
      );
    });

    it("allows access to system channels", () => {
      expect(canBatchTokenAccessChannel(batchPayload, "system").allowed).toBe(
        true,
      );
    });
  });

  describe("Denied Channels", () => {
    it("denies access to project not in batch", () => {
      const result = canBatchTokenAccessChannel(
        batchPayload,
        "project:unauthorized_project",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("unauthorized_project");
    });
  });
});

describe("canTokenAccessChannel (dispatcher)", () => {
  it("dispatches to session handler for session tokens", () => {
    const result = canTokenAccessChannel(sessionPayload, "session:sess_abc");
    expect(result.allowed).toBe(true);
  });

  it("dispatches to project handler for project tokens", () => {
    const result = canTokenAccessChannel(projectPayload, "project:proj_xyz");
    expect(result.allowed).toBe(true);
  });

  it("dispatches to batch handler for batch tokens", () => {
    const result = canTokenAccessChannel(batchPayload, "project:proj_one");
    expect(result.allowed).toBe(true);
  });

  it("rejects invalid token (no scope)", () => {
    const invalidPayload = {
      sub: "user_123",
      pid: "prod_test",
      typ: "read" as const,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as SessionScopedTokenPayload;

    const result = canTokenAccessChannel(invalidPayload, "session:sess_abc");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("no valid scope");
  });
});

describe("getAllowedChannelPatterns", () => {
  it("returns session patterns for session tokens", () => {
    const patterns = getAllowedChannelPatterns(sessionPayload);

    expect(patterns).toContain("system");
    expect(patterns).toContain("system.*");
    expect(patterns).toContain("session:sess_abc");
    expect(patterns).toContain("agent:sess_abc");
    expect(patterns).not.toContain("*");
    expect(patterns).not.toContain("project:proj_xyz");
  });

  it("returns project patterns for project tokens", () => {
    const patterns = getAllowedChannelPatterns(projectPayload);

    expect(patterns).toContain("system");
    expect(patterns).toContain("project:proj_xyz");
    expect(patterns).toContain("session:*");
    expect(patterns).toContain("agent:*");
    expect(patterns).not.toContain("*");
  });

  it("returns batch patterns for batch tokens", () => {
    const patterns = getAllowedChannelPatterns(batchPayload);

    expect(patterns).toContain("system");
    expect(patterns).toContain("*");
    expect(patterns).toContain("project:*");
    expect(patterns).toContain("project:proj_one");
    expect(patterns).toContain("project:proj_two");
    expect(patterns).toContain("project:proj_three");
    expect(patterns).toContain("session:*");
    expect(patterns).toContain("agent:*");
  });
});

describe("validateChannelSubscription", () => {
  it("validates multiple channels and returns split results", () => {
    const channels = [
      "session:sess_abc", // Allowed
      "agent:sess_abc", // Allowed
      "session:other", // Denied
      "system", // Allowed
      "*", // Denied (for session token)
    ];

    const result = validateChannelSubscription(sessionPayload, channels);

    expect(result.allowed).toContain("session:sess_abc");
    expect(result.allowed).toContain("agent:sess_abc");
    expect(result.allowed).toContain("system");
    expect(result.allowed).toHaveLength(3);

    expect(result.denied).toHaveLength(2);
    expect(
      result.denied.find((d) => d.channel === "session:other"),
    ).toBeTruthy();
    expect(result.denied.find((d) => d.channel === "*")).toBeTruthy();
  });

  it("returns all allowed for batch token with global access", () => {
    const channels = ["*", "project:proj_one", "session:any", "system"];

    const result = validateChannelSubscription(batchPayload, channels);

    expect(result.allowed).toHaveLength(4);
    expect(result.denied).toHaveLength(0);
  });
});

describe("Security: Privilege Escalation Prevention", () => {
  it("session token cannot access project channels", () => {
    const result = canTokenAccessChannel(sessionPayload, "project:any_project");
    expect(result.allowed).toBe(false);
  });

  it("session token cannot access other sessions", () => {
    const result = canTokenAccessChannel(
      sessionPayload,
      "session:other_session",
    );
    expect(result.allowed).toBe(false);
  });

  it("project token cannot access other projects", () => {
    const result = canTokenAccessChannel(
      projectPayload,
      "project:other_project",
    );
    expect(result.allowed).toBe(false);
  });

  it("batch token cannot access projects not in batch", () => {
    const result = canTokenAccessChannel(batchPayload, "project:unauthorized");
    expect(result.allowed).toBe(false);
  });
});

describe("Security: Edge Cases", () => {
  it("handles empty channel name", () => {
    const result = canTokenAccessChannel(sessionPayload, "");
    expect(result.allowed).toBe(true); // Default allow for unknown patterns
  });

  it("handles channel with special characters", () => {
    const result = canTokenAccessChannel(
      sessionPayload,
      "session:sess_abc/../other",
    );
    // The extraction should work literally, not do path traversal
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sess_abc");
  });

  it("handles very long channel names", () => {
    const longSessionId = "s".repeat(10000);
    const result = canTokenAccessChannel(
      sessionPayload,
      `session:${longSessionId}`,
    );
    expect(result.allowed).toBe(false);
  });

  it("handles channel with colons in value", () => {
    // session:abc:def should extract "abc:def" as the session ID
    const payload: SessionScopedTokenPayload = {
      ...sessionPayload,
      sid: "abc:def",
    };
    const result = canSessionTokenAccessChannel(payload, "session:abc:def");
    expect(result.allowed).toBe(true);
  });
});

describe("Security: Batch Token Project Array Attacks", () => {
  it("rejects empty projectIds array", () => {
    const emptyBatch = {
      ...batchPayload,
      projectIds: [],
    } as unknown as BatchScopedTokenPayload;

    // Even if an attacker crafts a token with empty array, it should fail
    const result = canBatchTokenAccessChannel(
      emptyBatch,
      "project:any_project",
    );
    expect(result.allowed).toBe(false);
  });

  it("handles projectIds with duplicates", () => {
    const duplicateBatch: BatchScopedTokenPayload = {
      ...batchPayload,
      projectIds: ["proj_one", "proj_one", "proj_one"],
    };

    const result = canBatchTokenAccessChannel(
      duplicateBatch,
      "project:proj_one",
    );
    expect(result.allowed).toBe(true);

    const otherResult = canBatchTokenAccessChannel(
      duplicateBatch,
      "project:proj_two",
    );
    expect(otherResult.allowed).toBe(false);
  });
});
