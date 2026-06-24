/**
 * Token Auth Unit Tests
 *
 * Comprehensive tests for JWT token issuance, verification, and utilities.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeToken,
  generateApiKey,
  generateSigningSecret,
  getTokenTTL,
  hashApiKey,
  issueReadToken,
  isTokenExpiringSoon,
  verifyApiKey,
  verifyReadToken,
} from "../../src/auth/tokens.js";
import type {
  ProductAuthInfo,
  ReadTokenPayload,
} from "../../src/auth/types.js";

// Test constants
const TEST_PRODUCT_ID = "prod_test123";
const TEST_USER_ID = "user_abc";
const TEST_SESSION_ID = "sess_xyz";
const TEST_SIGNING_SECRET = "orch_sign_test-secret-32-bytes-long!!";

// Helper to create ProductAuthInfo
function createProductAuthInfo(
  secret: string,
  options?: {
    productId?: string;
    status?: "active" | "suspended" | "deleted";
    previousSecret?: { secret: string; expiresAt: number };
  },
): ProductAuthInfo {
  return {
    product_id: options?.productId ?? TEST_PRODUCT_ID,
    secrets: {
      current: { secret, created_at: Date.now() },
      ...(options?.previousSecret && {
        previous: {
          secret: options.previousSecret.secret,
          created_at: Date.now() - 86400000, // 1 day ago
          expires_at: options.previousSecret.expiresAt,
        },
      }),
    },
    status: options?.status ?? "active",
  };
}

describe("Token Generation", () => {
  describe("generateApiKey", () => {
    it("generates keys with correct prefix", () => {
      const key = generateApiKey();
      expect(key.startsWith("orch_prod_")).toBe(true);
    });

    it("generates unique keys on each call", () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1).not.toBe(key2);
    });

    it("generates keys of sufficient length", () => {
      const key = generateApiKey();
      // orch_prod_ (10) + 32 bytes base64url encoded (~43 chars)
      expect(key.length).toBeGreaterThan(50);
    });
  });

  describe("generateSigningSecret", () => {
    it("generates secrets with correct prefix", () => {
      const secret = generateSigningSecret();
      expect(secret.startsWith("orch_sign_")).toBe(true);
    });

    it("generates unique secrets on each call", () => {
      const secret1 = generateSigningSecret();
      const secret2 = generateSigningSecret();
      expect(secret1).not.toBe(secret2);
    });
  });
});

describe("issueReadToken", () => {
  it("creates valid JWT format (header.payload.signature)", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );

    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBeTruthy(); // header
    expect(parts[1]).toBeTruthy(); // payload
    expect(parts[2]).toBeTruthy(); // signature
  });

  it("includes all required claims in payload", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );

    const decoded = decodeToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe(TEST_USER_ID);
    expect(decoded?.sid).toBe(TEST_SESSION_ID);
    expect(decoded?.pid).toBe(TEST_PRODUCT_ID);
    expect(decoded?.typ).toBe("read");
  });

  it("sets correct expiration based on TTL", () => {
    const ttlMinutes = 30;
    const beforeIssue = Math.floor(Date.now() / 1000);

    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      ttlMinutes,
    );

    const decoded = decodeToken(token);
    const expectedExp = beforeIssue + ttlMinutes * 60;

    // Allow 1 second tolerance for timing
    expect(decoded?.exp).toBeGreaterThanOrEqual(expectedExp - 1);
    expect(decoded?.exp).toBeLessThanOrEqual(expectedExp + 1);
  });

  it("generates different tokens for different secrets", () => {
    const token1 = issueReadToken(
      "secret-1-32-bytes-long!!!!!!!!!!",
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const token2 = issueReadToken(
      "secret-2-32-bytes-long!!!!!!!!!!",
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );

    expect(token1).not.toBe(token2);
  });

  it("generates different tokens for different users", () => {
    const token1 = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: "user1", sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const token2 = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: "user2", sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );

    expect(token1).not.toBe(token2);
  });
});

describe("decodeToken", () => {
  it("decodes valid token", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );

    const decoded = decodeToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe(TEST_USER_ID);
  });

  it("returns null for malformed token (missing parts)", () => {
    expect(decodeToken("not-a-token")).toBeNull();
    expect(decodeToken("only.two")).toBeNull();
    expect(decodeToken("")).toBeNull();
  });

  it("returns null for invalid base64 payload", () => {
    expect(decodeToken("header.!!!invalid!!!.signature")).toBeNull();
  });

  it("decodes without verifying signature", () => {
    // Create a token and tamper with the signature
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const parts = token.split(".");
    const tamperedToken = `${parts[0]}.${parts[1]}.tampered-signature`;

    // decodeToken should still decode (it doesn't verify)
    const decoded = decodeToken(tamperedToken);
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe(TEST_USER_ID);
  });
});

describe("verifyReadToken", () => {
  it("accepts valid token with correct secret", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const product = createProductAuthInfo(TEST_SIGNING_SECRET);

    const result = verifyReadToken(token, product);

    expect(result.valid).toBe(true);
    expect(result.payload).toBeDefined();
    expect(result.payload?.sub).toBe(TEST_USER_ID);
    expect(result.payload?.sid).toBe(TEST_SESSION_ID);
    expect(result.payload?.pid).toBe(TEST_PRODUCT_ID);
  });

  it("rejects token with wrong secret", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const product = createProductAuthInfo("wrong-secret-32-bytes-long!!!!!");

    const result = verifyReadToken(token, product);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("SIGNATURE_INVALID");
  });

  it("rejects expired token", () => {
    // Issue token with -1 minute TTL (already expired)
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      -1,
    );
    const product = createProductAuthInfo(TEST_SIGNING_SECRET);

    const result = verifyReadToken(token, product);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("TOKEN_EXPIRED");
  });

  it("rejects token for suspended product", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60,
    );
    const product = createProductAuthInfo(TEST_SIGNING_SECRET, {
      status: "suspended",
    });

    const result = verifyReadToken(token, product);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("PRODUCT_SUSPENDED");
  });

  it("rejects token with mismatched product ID", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: "different-product" },
      60,
    );
    const product = createProductAuthInfo(TEST_SIGNING_SECRET);

    const result = verifyReadToken(token, product);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("TOKEN_INVALID");
  });

  it("rejects malformed token", () => {
    const product = createProductAuthInfo(TEST_SIGNING_SECRET);

    expect(verifyReadToken("not-a-token", product).valid).toBe(false);
    expect(verifyReadToken("only.two", product).valid).toBe(false);
  });

  describe("secret rotation", () => {
    it("accepts token signed with previous secret during grace period", () => {
      const oldSecret = "old-secret-32-bytes-long!!!!!!!!!";
      const newSecret = "new-secret-32-bytes-long!!!!!!!!!";

      // Token signed with old secret
      const token = issueReadToken(
        oldSecret,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );

      // Product rotated to new secret, but old secret still in grace period
      const product = createProductAuthInfo(newSecret, {
        previousSecret: {
          secret: oldSecret,
          expiresAt: Date.now() + 86400000, // Grace period ends tomorrow
        },
      });

      const result = verifyReadToken(token, product);
      expect(result.valid).toBe(true);
    });

    it("rejects token signed with previous secret after grace period", () => {
      const oldSecret = "old-secret-32-bytes-long!!!!!!!!!";
      const newSecret = "new-secret-32-bytes-long!!!!!!!!!";

      // Token signed with old secret
      const token = issueReadToken(
        oldSecret,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );

      // Product rotated to new secret, grace period expired
      const product = createProductAuthInfo(newSecret, {
        previousSecret: {
          secret: oldSecret,
          expiresAt: Date.now() - 1000, // Grace period ended 1 second ago
        },
      });

      const result = verifyReadToken(token, product);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("SIGNATURE_INVALID");
    });

    it("accepts token signed with current secret when previous exists", () => {
      const oldSecret = "old-secret-32-bytes-long!!!!!!!!!";
      const newSecret = "new-secret-32-bytes-long!!!!!!!!!";

      // Token signed with new (current) secret
      const token = issueReadToken(
        newSecret,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );

      // Product has both secrets
      const product = createProductAuthInfo(newSecret, {
        previousSecret: {
          secret: oldSecret,
          expiresAt: Date.now() + 86400000,
        },
      });

      const result = verifyReadToken(token, product);
      expect(result.valid).toBe(true);
    });
  });

  describe("algorithm pinning (defense-in-depth)", () => {
    /**
     * Hand-build a JWT with a caller-supplied header so we can exercise
     * the alg-confusion guard. `issueReadToken` always produces a
     * canonical `{alg:HS256,typ:JWT}` header, which would skip the
     * fallback parse path entirely.
     */
    function craftToken(
      header: Record<string, unknown>,
      payload: Record<string, unknown>,
      secret: string,
    ): string {
      const headerB64 = Buffer.from(JSON.stringify(header)).toString(
        "base64url",
      );
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const sig = createHmac("sha256", secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest("base64url");
      return `${headerB64}.${payloadB64}.${sig}`;
    }

    function basePayload() {
      const now = Math.floor(Date.now() / 1000);
      return {
        sub: TEST_USER_ID,
        sid: TEST_SESSION_ID,
        pid: TEST_PRODUCT_ID,
        typ: "read",
        iat: now,
        exp: now + 3600,
      };
    }

    it("rejects a token whose header advertises alg: none", () => {
      // The classic JWT alg-confusion: a forged header with `alg:none`
      // and an empty signature would let an attacker mint tokens
      // unilaterally if the verifier ever dispatched on header.alg.
      // Pinning makes this impossible by construction.
      const headerB64 = Buffer.from(
        JSON.stringify({ alg: "none", typ: "JWT" }),
      ).toString("base64url");
      const payloadB64 = Buffer.from(JSON.stringify(basePayload())).toString(
        "base64url",
      );
      const noneToken = `${headerB64}.${payloadB64}.`;
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(noneToken, product);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("TOKEN_INVALID");
      expect(result.error).toBe("Unsupported token algorithm");
    });

    it("rejects a token whose header advertises a non-HS256 algorithm", () => {
      // Even if the attacker computes a valid HMAC-SHA256 over the
      // HS512-claimed header (so the byte-level signature would match),
      // pinning rejects the request before the signature check runs.
      const token = craftToken(
        { alg: "HS512", typ: "JWT" },
        basePayload(),
        TEST_SIGNING_SECRET,
      );
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(token, product);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("TOKEN_INVALID");
      expect(result.error).toBe("Unsupported token algorithm");
    });

    it("rejects a token whose header is missing alg entirely", () => {
      const token = craftToken(
        { typ: "JWT" },
        basePayload(),
        TEST_SIGNING_SECRET,
      );
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(token, product);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("TOKEN_INVALID");
    });

    it("rejects a token whose header is unparseable JSON", () => {
      // The header decodes to bytes but JSON.parse throws on them. The
      // alg-pin guard catches the throw and returns TOKEN_INVALID
      // rather than letting the error escape.
      const headerB64 = Buffer.from("not-json-at-all").toString("base64url");
      const payloadB64 = Buffer.from(JSON.stringify(basePayload())).toString(
        "base64url",
      );
      const sig = createHmac("sha256", TEST_SIGNING_SECRET)
        .update(`${headerB64}.${payloadB64}`)
        .digest("base64url");
      const token = `${headerB64}.${payloadB64}.${sig}`;
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(token, product);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("TOKEN_INVALID");
    });

    it("accepts a non-canonical but valid HS256 header (extra kid claim)", () => {
      // `JWT_HEADER` fast-path equality fails for headers that include
      // optional fields like `kid`, so verification falls through to
      // the JSON-parse path. The alg is still HS256 → continue, then
      // raw-byte signature compare passes.
      const token = craftToken(
        { alg: "HS256", typ: "JWT", kid: "key-1" },
        basePayload(),
        TEST_SIGNING_SECRET,
      );
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(token, product);
      expect(result.valid).toBe(true);
      expect(result.payload?.sub).toBe(TEST_USER_ID);
    });
  });

  describe("signature verification edge cases (raw-byte path)", () => {
    it("rejects a token with a tampered payload", () => {
      // Issue a real token, swap the payload for a forged one without
      // re-signing. The raw-byte HMAC compare must reject this.
      const token = issueReadToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const [headerB64, , sigB64] = token.split(".");
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          sub: "attacker",
          sid: "evil-session",
          pid: TEST_PRODUCT_ID,
          typ: "read",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url");
      const tamperedToken = `${headerB64}.${tamperedPayload}.${sigB64}`;
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(tamperedToken, product);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("SIGNATURE_INVALID");
    });

    it("rejects a malformed base64url signature without throwing", () => {
      // The new raw-byte verifier decodes the signature with
      // `Buffer.from(sig, "base64")`; on bizarre inputs we must return
      // SIGNATURE_INVALID rather than let an exception escape.
      const token = issueReadToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const [headerB64, payloadB64] = token.split(".");
      // Empty signature segment, garbage bytes, and a too-short
      // signature are all "decode-but-don't-match" failure modes.
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);
      for (const badSig of ["", "!!!@@@###", "AAAA", "x".repeat(2)]) {
        const bad = `${headerB64}.${payloadB64}.${badSig}`;
        const result = verifyReadToken(bad, product);
        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe("SIGNATURE_INVALID");
      }
    });

    it("rejects a signature whose decoded length differs from the digest", () => {
      // 32-byte HMAC-SHA256 → 43 base64url chars decoding to 32 bytes.
      // A 24-byte signature decodes successfully but length-mismatches
      // the expected digest, which the verifier must catch without
      // calling `timingSafeEqual` (it would throw on unequal lengths).
      const token = issueReadToken(
        TEST_SIGNING_SECRET,
        { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
        60,
      );
      const [headerB64, payloadB64] = token.split(".");
      const shortSig = Buffer.alloc(24, 0).toString("base64url");
      const product = createProductAuthInfo(TEST_SIGNING_SECRET);

      const result = verifyReadToken(
        `${headerB64}.${payloadB64}.${shortSig}`,
        product,
      );
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("SIGNATURE_INVALID");
    });
  });
});

describe("getTokenTTL", () => {
  it("returns positive TTL for valid token", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60, // 60 minutes
    );

    const decoded = decodeToken(token);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    const ttl = getTokenTTL(decoded);

    // Should be close to 60 minutes (3600 seconds)
    expect(ttl).toBeGreaterThan(3590);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it("returns negative TTL for expired token", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      -1, // Already expired
    );

    const decoded = decodeToken(token);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    const ttl = getTokenTTL(decoded);

    expect(ttl).toBeLessThan(0);
  });
});

describe("isTokenExpiringSoon", () => {
  it("returns false for token with plenty of time", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      60, // 60 minutes
    );

    const decoded = decodeToken(token);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(isTokenExpiringSoon(decoded, 60)).toBe(false); // 60 second buffer
    expect(isTokenExpiringSoon(decoded, 300)).toBe(false); // 5 minute buffer
  });

  it("returns true for token expiring within buffer", () => {
    // Create a token that expires in 30 seconds
    const now = Math.floor(Date.now() / 1000);
    const payload: ReadTokenPayload = {
      sub: TEST_USER_ID,
      sid: TEST_SESSION_ID,
      pid: TEST_PRODUCT_ID,
      typ: "read",
      iat: now,
      exp: now + 30, // Expires in 30 seconds
    };

    expect(isTokenExpiringSoon(payload, 60)).toBe(true); // 60 second buffer
    expect(isTokenExpiringSoon(payload, 20)).toBe(false); // 20 second buffer
  });

  it("returns true for already expired token", () => {
    const token = issueReadToken(
      TEST_SIGNING_SECRET,
      { sub: TEST_USER_ID, sid: TEST_SESSION_ID, pid: TEST_PRODUCT_ID },
      -1,
    );

    const decoded = decodeToken(token);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(isTokenExpiringSoon(decoded)).toBe(true);
  });
});

describe("API Key Utilities", () => {
  describe("hashApiKey", () => {
    it("produces consistent hash for same key", () => {
      const key = "orch_prod_test-key-123";
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different keys", () => {
      const hash1 = hashApiKey("key1");
      const hash2 = hashApiKey("key2");

      expect(hash1).not.toBe(hash2);
    });

    it("produces hex string", () => {
      const hash = hashApiKey("test-key");
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("verifyApiKey", () => {
    it("returns true for matching keys", () => {
      const key = "orch_prod_test-key";
      expect(verifyApiKey(key, key)).toBe(true);
    });

    it("returns false for non-matching keys", () => {
      expect(verifyApiKey("key1", "key2")).toBe(false);
    });

    it("returns false for keys of different lengths", () => {
      expect(verifyApiKey("short", "longer-key")).toBe(false);
    });
  });
});
