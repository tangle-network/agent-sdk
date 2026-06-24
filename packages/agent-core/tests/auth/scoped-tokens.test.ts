/**
 * Scoped Token Security Tests
 *
 * Comprehensive tests for multi-scope JWT tokens (session, project, batch).
 * Tests include:
 * - Token issuance for all scopes
 * - Scope detection accuracy
 * - Verification edge cases
 * - Cross-scope attack prevention
 * - Token tampering detection
 * - Channel authorization security
 */

import { describe, expect, it } from "vitest";
import {
  decodeToken,
  getTokenScope,
  isBatchScopedToken,
  isProjectScopedToken,
  isSessionScopedToken,
  issueBatchScopedToken,
  issueProjectScopedToken,
  issueReadToken,
  issueSessionScopedToken,
  validateTokenScope,
  verifyReadToken,
} from "../../src/auth/index.js";
import type {
  BatchScopedTokenPayload,
  ProductAuthInfo,
  ProjectScopedTokenPayload,
  ReadTokenPayload,
  SessionScopedTokenPayload,
} from "../../src/auth/types.js";

// Test constants
const TEST_PRODUCT_ID = "prod_test_scoped";
const TEST_USER_ID = "user_scope_test";
const TEST_SESSION_ID = "sess_abc123";
const TEST_PROJECT_ID = "proj_xyz789";
const TEST_PROJECT_IDS = ["proj_one", "proj_two", "proj_three"];
const TEST_SIGNING_SECRET = "orch_sign_scoped-test-secret-32bytes!";

/** Decode token and throw if null — avoids non-null assertions in tests */
function decodeTokenOrFail(token: string): ReadTokenPayload {
  const decoded = decodeToken(token);
  if (!decoded) throw new Error("decodeToken returned null");
  return decoded;
}

// Helper to create ProductAuthInfo
function createProductAuthInfo(
  secret: string,
  options?: {
    productId?: string;
    status?: "active" | "suspended" | "deleted";
  },
): ProductAuthInfo {
  return {
    product_id: options?.productId ?? TEST_PRODUCT_ID,
    secrets: {
      current: { secret, created_at: Date.now() },
    },
    status: options?.status ?? "active",
  };
}

describe("Session-Scoped Tokens", () => {
  describe("issueSessionScopedToken", () => {
    it("creates valid session-scoped token", () => {
      const token = issueSessionScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );

      const decoded = decodeTokenOrFail(token);
      expect(decoded?.sub).toBe(TEST_USER_ID);
      expect(decoded?.sid).toBe(TEST_SESSION_ID);
      expect(decoded?.pid).toBe(TEST_PRODUCT_ID);
      expect(decoded?.typ).toBe("read");
    });

    it("does not include projectId or projectIds", () => {
      const token = issueSessionScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );

      const decoded = decodeTokenOrFail(token);
      expect(decoded?.projectId).toBeUndefined();
      expect(decoded?.projectIds).toBeUndefined();
    });

    it("verifies successfully", () => {
      const token = issueSessionScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(token, product);

      expect(result.valid).toBe(true);
      expect(result.scope).toBe("session");
    });
  });

  describe("isSessionScopedToken", () => {
    it("returns true for session-scoped tokens", () => {
      const token = issueSessionScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isSessionScopedToken(decoded)).toBe(true);
    });

    it("returns false for project-scoped tokens", () => {
      const token = issueProjectScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isSessionScopedToken(decoded)).toBe(false);
    });

    it("returns false for batch-scoped tokens", () => {
      const token = issueBatchScopedToken(
        TEST_SIGNING_SECRET,
        {
          sub: TEST_USER_ID,
          projectIds: TEST_PROJECT_IDS,
          pid: TEST_PRODUCT_ID,
        },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isSessionScopedToken(decoded)).toBe(false);
    });
  });
});

describe("Project-Scoped Tokens", () => {
  describe("issueProjectScopedToken", () => {
    it("creates valid project-scoped token", () => {
      const token = issueProjectScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: TEST_PRODUCT_ID },
        60,
      );

      const decoded = decodeTokenOrFail(token);
      expect(decoded?.sub).toBe(TEST_USER_ID);
      expect(decoded?.projectId).toBe(TEST_PROJECT_ID);
      expect(decoded?.pid).toBe(TEST_PRODUCT_ID);
    });

    it("does not include sid or projectIds", () => {
      const token = issueProjectScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: TEST_PRODUCT_ID },
        60,
      );

      const decoded = decodeTokenOrFail(token);
      expect(decoded?.sid).toBeUndefined();
      expect(decoded?.projectIds).toBeUndefined();
    });

    it("verifies successfully", () => {
      const token = issueProjectScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(token, product);

      expect(result.valid).toBe(true);
      expect(result.scope).toBe("project");
    });
  });

  describe("isProjectScopedToken", () => {
    it("returns true for project-scoped tokens", () => {
      const token = issueProjectScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isProjectScopedToken(decoded)).toBe(true);
    });

    it("returns false for session-scoped tokens", () => {
      const token = issueSessionScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isProjectScopedToken(decoded)).toBe(false);
    });

    it("returns false for batch-scoped tokens", () => {
      const token = issueBatchScopedToken(
        TEST_SIGNING_SECRET,
        {
          sub: TEST_USER_ID,
          projectIds: TEST_PROJECT_IDS,
          pid: TEST_PRODUCT_ID,
        },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isProjectScopedToken(decoded)).toBe(false);
    });
  });
});

describe("Batch-Scoped Tokens", () => {
  describe("issueBatchScopedToken", () => {
    it("creates valid batch-scoped token", () => {
      const token = issueBatchScopedToken(
        TEST_SIGNING_SECRET,
        {
          sub: TEST_USER_ID,
          projectIds: TEST_PROJECT_IDS,
          pid: TEST_PRODUCT_ID,
        },
        60,
      );

      const decoded = decodeTokenOrFail(token);
      expect(decoded?.sub).toBe(TEST_USER_ID);
      expect(decoded?.projectIds).toEqual(TEST_PROJECT_IDS);
      expect(decoded?.pid).toBe(TEST_PRODUCT_ID);
    });

    it("does not include sid or projectId", () => {
      const token = issueBatchScopedToken(
        TEST_SIGNING_SECRET,
        {
          sub: TEST_USER_ID,
          projectIds: TEST_PROJECT_IDS,
          pid: TEST_PRODUCT_ID,
        },
        60,
      );

      const decoded = decodeTokenOrFail(token);
      expect(decoded?.sid).toBeUndefined();
      expect(decoded?.projectId).toBeUndefined();
    });

    it("verifies successfully", () => {
      const token = issueBatchScopedToken(
        TEST_SIGNING_SECRET,
        {
          sub: TEST_USER_ID,
          projectIds: TEST_PROJECT_IDS,
          pid: TEST_PRODUCT_ID,
        },
        60,
      );
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(token, product);

      expect(result.valid).toBe(true);
      expect(result.scope).toBe("batch");
    });

    it("preserves project order in projectIds", () => {
      const orderedIds = ["z_last", "a_first", "m_middle"];
      const token = issueBatchScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, projectIds: orderedIds, pid: TEST_PRODUCT_ID },
        60,
      );

      const decoded = decodeTokenOrFail(token);
      expect(decoded?.projectIds).toEqual(orderedIds);
    });
  });

  describe("isBatchScopedToken", () => {
    it("returns true for batch-scoped tokens", () => {
      const token = issueBatchScopedToken(
        TEST_SIGNING_SECRET,
        {
          sub: TEST_USER_ID,
          projectIds: TEST_PROJECT_IDS,
          pid: TEST_PRODUCT_ID,
        },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isBatchScopedToken(decoded)).toBe(true);
    });

    it("returns false for session-scoped tokens", () => {
      const token = issueSessionScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isBatchScopedToken(decoded)).toBe(false);
    });

    it("returns false for project-scoped tokens", () => {
      const token = issueProjectScopedToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const decoded = decodeTokenOrFail(token);

      expect(isBatchScopedToken(decoded)).toBe(false);
    });
  });
});

describe("getTokenScope", () => {
  it("returns 'session' for session-scoped tokens", () => {
    const token = issueSessionScopedToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const decoded = decodeTokenOrFail(token);

    expect(getTokenScope(decoded)).toBe("session");
  });

  it("returns 'project' for project-scoped tokens", () => {
    const token = issueProjectScopedToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const decoded = decodeTokenOrFail(token);

    expect(getTokenScope(decoded)).toBe("project");
  });

  it("returns 'batch' for batch-scoped tokens", () => {
    const token = issueBatchScopedToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, projectIds: TEST_PROJECT_IDS, pid: TEST_PRODUCT_ID },
      60,
    );
    const decoded = decodeTokenOrFail(token);

    expect(getTokenScope(decoded)).toBe("batch");
  });

  it("returns null for invalid scope (no scope claims)", () => {
    // Create a malformed payload without scope claims
    const malformed = {
      sub: TEST_USER_ID,
      pid: TEST_PRODUCT_ID,
      typ: "read" as const,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as ReadTokenPayload;

    expect(getTokenScope(malformed)).toBeNull();
  });
});

describe("validateTokenScope", () => {
  it("returns null for valid session scope", () => {
    const payload: SessionScopedTokenPayload = {
      sub: TEST_USER_ID,
      sid: TEST_SESSION_ID,
      pid: TEST_PRODUCT_ID,
      typ: "read",
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 3600,
    };

    expect(validateTokenScope(payload)).toBeNull();
  });

  it("returns null for valid project scope", () => {
    const payload: ProjectScopedTokenPayload = {
      sub: TEST_USER_ID,
      projectId: TEST_PROJECT_ID,
      pid: TEST_PRODUCT_ID,
      typ: "read",
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 3600,
    };

    expect(validateTokenScope(payload)).toBeNull();
  });

  it("returns null for valid batch scope", () => {
    const payload: BatchScopedTokenPayload = {
      sub: TEST_USER_ID,
      projectIds: TEST_PROJECT_IDS,
      pid: TEST_PRODUCT_ID,
      typ: "read",
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 3600,
    };

    expect(validateTokenScope(payload)).toBeNull();
  });

  it("returns error for missing scope", () => {
    const malformed = {
      sub: TEST_USER_ID,
      pid: TEST_PRODUCT_ID,
      typ: "read",
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 3600,
    } as ReadTokenPayload;

    const error = validateTokenScope(malformed);
    expect(error).toContain("must have one of");
  });

  it("returns error for multiple scopes (sid + projectId)", () => {
    const conflicting = {
      sub: TEST_USER_ID,
      sid: TEST_SESSION_ID,
      projectId: TEST_PROJECT_ID,
      pid: TEST_PRODUCT_ID,
      typ: "read",
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 3600,
    } as unknown as ReadTokenPayload;

    const error = validateTokenScope(conflicting);
    expect(error).toContain("mutually exclusive");
  });

  it("returns error for multiple scopes (sid + projectIds)", () => {
    const conflicting = {
      sub: TEST_USER_ID,
      sid: TEST_SESSION_ID,
      projectIds: TEST_PROJECT_IDS,
      pid: TEST_PRODUCT_ID,
      typ: "read",
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 3600,
    } as unknown as ReadTokenPayload;

    const error = validateTokenScope(conflicting);
    expect(error).toContain("mutually exclusive");
  });

  it("returns error for all three scopes present", () => {
    const conflicting = {
      sub: TEST_USER_ID,
      sid: TEST_SESSION_ID,
      projectId: TEST_PROJECT_ID,
      projectIds: TEST_PROJECT_IDS,
      pid: TEST_PRODUCT_ID,
      typ: "read",
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 3600,
    } as unknown as ReadTokenPayload;

    const error = validateTokenScope(conflicting);
    expect(error).toContain("mutually exclusive");
  });
});

describe("Security: Token Tampering Detection", () => {
  it("rejects token with modified scope", () => {
    const token = issueSessionScopedToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );

    // Decode, modify, and re-encode (simulating tampering)
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.projectId = "hacked_project"; // Try to escalate to project scope
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tamperedToken = parts.join(".");

    const product = createProductAuthInfo(TEST_SIGNING_SECRET);
    const result = verifyReadToken(tamperedToken, product);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("SIGNATURE_INVALID");
  });

  it("rejects token with modified projectIds", () => {
    const token = issueBatchScopedToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, projectIds: ["proj_a"], pid: TEST_PRODUCT_ID },
      60,
    );

    // Try to add more projects
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.projectIds = ["proj_a", "proj_b", "proj_c"];
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tamperedToken = parts.join(".");

    const product = createProductAuthInfo(TEST_SIGNING_SECRET);
    const result = verifyReadToken(tamperedToken, product);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("SIGNATURE_INVALID");
  });

  it("rejects token with different product secret", () => {
    const token = issueProjectScopedToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: TEST_PRODUCT_ID },
      60,
    );

    const differentProduct = createProductAuthInfo(
      "different-secret-32-bytes-long!!",
    );
    const result = verifyReadToken(token, differentProduct);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("SIGNATURE_INVALID");
  });
});

describe("Security: Cross-Product Token Reuse", () => {
  it("rejects token for different product", () => {
    const token = issueProjectScopedToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, projectId: TEST_PROJECT_ID, pid: "product_a" },
      60,
    );

    const differentProduct = createProductAuthInfo(TEST_SIGNING_SECRET, {
      productId: "product_b",
    });

    const result = verifyReadToken(token, differentProduct);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("TOKEN_INVALID");
  });
});

describe("Backwards Compatibility", () => {
  it("issueReadToken works with session payload (backward compat)", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const product = createProductAuthInfo(TEST_SIGNING_SECRET);

    const result = verifyReadToken(token, product);

    expect(result.valid).toBe(true);
    expect(result.scope).toBe("session");
  });

  it("existing session tokens still verify correctly", () => {
    // Simulate an "old" token format (before scoped tokens)
    const token = issueSessionScopedToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const product = createProductAuthInfo(TEST_SIGNING_SECRET);

    const result = verifyReadToken(token, product);

    expect(result.valid).toBe(true);
    expect(result.payload?.sid).toBe(TEST_SESSION_ID);
  });
});
