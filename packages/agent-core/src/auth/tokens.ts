/**
 * JWT Token Utilities
 *
 * Token generation and verification for multi-tenant auth.
 * - Read/product tokens: HMAC-SHA256 (symmetric, fast)
 * - Sidecar tokens: Ed25519 (asymmetric — sidecar cannot forge tokens)
 */

import type {
  BatchScopedTokenPayload,
  ProductAuthInfo,
  ProjectScopedTokenPayload,
  ReadTokenPayload,
  SessionScopedTokenPayload,
  TokenScope,
  TokenValidationResult,
} from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type NodeCrypto = typeof import("node:crypto");
let nodeCryptoCache: NodeCrypto | undefined;

/**
 * Resolve Node's `crypto` lazily and synchronously. Signing, verification, and
 * key generation are server-only, but this module must stay importable in a
 * browser bundle — a static `import "node:crypto"` forces bundlers to resolve
 * the builtin at load and blanks the page. `process.getBuiltinModule` exists
 * only on a Node runtime (Node >= 22.3); in a browser `globalThis.process` is
 * undefined, so callers get a clear server-only error instead of a crash.
 */
function nodeCrypto(): NodeCrypto {
  if (nodeCryptoCache) return nodeCryptoCache;
  const resolved = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown };
    }
  ).process?.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined;
  if (!resolved) {
    throw new Error(
      "@tangle-network/agent-core/auth: token signing, verification, and key generation are server-only (Node.js crypto) and cannot run in a browser.",
    );
  }
  nodeCryptoCache = resolved;
  return resolved;
}

/**
 * Generate a cryptographically secure random string.
 * @param prefix - Prefix for the generated string (e.g., "orch_prod_")
 * @param bytes - Number of random bytes (default: 32 = 256 bits)
 */
export function generateSecureToken(prefix: string, bytes = 32): string {
  return `${prefix}${base64UrlEncode(nodeCrypto().randomBytes(bytes))}`;
}

/**
 * Generate a product API key.
 */
export function generateApiKey(): string {
  return generateSecureToken("orch_prod_");
}

/**
 * Generate a signing secret.
 */
export function generateSigningSecret(): string {
  return generateSecureToken("orch_sign_");
}

/**
 * Base64URL encode (RFC 7515). Isomorphic: `btoa` + `TextEncoder` exist in Node
 * and browsers, so — unlike `Buffer` — this never blanks a browser page that
 * transitively imports the module.
 */
function base64UrlEncode(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Base64URL decode (RFC 7515) to raw bytes.
 */
function base64UrlToBytes(data: string): Uint8Array {
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Base64URL decode to a UTF-8 string.
 */
function base64UrlDecode(data: string): string {
  return textDecoder.decode(base64UrlToBytes(data));
}

/**
 * Create HMAC-SHA256 signature.
 */
function createSignature(data: string, secret: string): string {
  return base64UrlEncode(
    nodeCrypto().createHmac("sha256", secret).update(data).digest(),
  );
}

/**
 * Verify signature using timing-safe comparison on raw HMAC bytes.
 *
 * Decoding both sides to raw bytes before the compare strips the
 * length-of-base64url-string oracle: every legitimate signature
 * decodes to exactly 32 bytes (HMAC-SHA256 digest size), so a
 * length mismatch on the decoded buffer means malformed input,
 * not a partial match. Equivalent to the pattern used in
 * `products/sandbox/sdk/src/auth/tokens.ts`.
 */
function verifySignature(
  data: string,
  signature: string,
  secret: string,
): boolean {
  const { createHmac, timingSafeEqual } = nodeCrypto();
  const expectedBuf = createHmac("sha256", secret).update(data).digest();
  let providedBuf: Uint8Array;
  try {
    providedBuf = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Base64URL-encoded JWT header `{"alg":"HS256","typ":"JWT"}`. Computed on first
 * use (not at module load) and memoized.
 */
let jwtHeaderCache: string | undefined;
function jwtHeader(): string {
  if (jwtHeaderCache === undefined) {
    jwtHeaderCache = base64UrlEncode(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    );
  }
  return jwtHeaderCache;
}

/**
 * Issue a read token (JWT) for WebSocket authentication.
 *
 * @param signingSecret - The product's signing secret
 * @param payload - Token payload (without iat/exp, those are added)
 * @param ttlMinutes - Token TTL in minutes
 */
export function issueReadToken(
  signingSecret: string,
  payload: Omit<ReadTokenPayload, "iat" | "exp" | "typ">,
  ttlMinutes: number,
): string {
  const now = Math.floor(Date.now() / 1000);

  // Type assertion is safe here: payload already satisfies one branch of the
  // ReadTokenPayload union (minus iat/exp/typ), and we're adding those fields.
  // TypeScript can't infer which union branch we're creating from a spread.
  const fullPayload = {
    ...payload,
    typ: "read" as const,
    iat: now,
    exp: now + ttlMinutes * 60,
  } as ReadTokenPayload;

  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${jwtHeader()}.${encodedPayload}`;
  const signature = createSignature(data, signingSecret);

  return `${data}.${signature}`;
}

/**
 * Issue a session-scoped token (JWT) for WebSocket authentication.
 * Grants access to a single session's events.
 *
 * @param signingSecret - The product's signing secret
 * @param payload - Token payload with session ID
 * @param ttlMinutes - Token TTL in minutes
 */
export function issueSessionScopedToken(
  signingSecret: string,
  payload: Omit<SessionScopedTokenPayload, "iat" | "exp" | "typ">,
  ttlMinutes: number,
): string {
  return issueReadToken(signingSecret, payload, ttlMinutes);
}

/**
 * Issue a project-scoped token (JWT) for WebSocket authentication.
 * Grants access to all sessions within a single project.
 *
 * @param signingSecret - The product's signing secret
 * @param payload - Token payload with project ID
 * @param ttlMinutes - Token TTL in minutes
 */
export function issueProjectScopedToken(
  signingSecret: string,
  payload: Omit<ProjectScopedTokenPayload, "iat" | "exp" | "typ">,
  ttlMinutes: number,
): string {
  return issueReadToken(
    signingSecret,
    payload as Omit<ReadTokenPayload, "iat" | "exp" | "typ">,
    ttlMinutes,
  );
}

/**
 * Issue a batch-scoped token (JWT) for WebSocket authentication.
 * Grants access to multiple projects (organization-level access).
 *
 * @param signingSecret - The product's signing secret
 * @param payload - Token payload with project IDs array
 * @param ttlMinutes - Token TTL in minutes
 */
export function issueBatchScopedToken(
  signingSecret: string,
  payload: Omit<BatchScopedTokenPayload, "iat" | "exp" | "typ">,
  ttlMinutes: number,
): string {
  return issueReadToken(
    signingSecret,
    payload as Omit<ReadTokenPayload, "iat" | "exp" | "typ">,
    ttlMinutes,
  );
}

// Ed25519 JWT header (asymmetric — sidecar cannot forge tokens); computed on
// first use, not at module load, so the module stays browser-importable.
let jwtHeaderEddsaCache: string | undefined;
function jwtHeaderEddsa(): string {
  if (jwtHeaderEddsaCache === undefined) {
    jwtHeaderEddsaCache = base64UrlEncode(
      JSON.stringify({ alg: "EdDSA", typ: "JWT" }),
    );
  }
  return jwtHeaderEddsaCache;
}

/**
 * Capability strings carried in a sidecar token's `cap` claim. This is the
 * shared vocabulary the crypto layer stamps into the JWT (issueSidecarAccessToken)
 * and reads back out (verifySidecarToken). The route→capability authorization
 * policy that enforces these claims lives in the sidecar layer, not here.
 * Tokens with a `cap` claim are strictly limited to those capabilities; tokens
 * without a `cap` claim are full-scope (legacy orchestrator-internal use).
 *
 * Adding a new capability: extend this union, then update the enforcement
 * policy (route maps + authorization check) in the sidecar-auth package.
 */
export type SidecarCapability =
  | "computer_use"
  | "read"
  | "debug"
  | "terminal"
  | "control"
  | "raw_input";

/**
 * Generate an Ed25519 key pair for per-session JWT signing.
 * Private key stays in orchestrator memory. Public key is injected into
 * the sidecar container. Even if the sidecar is fully compromised,
 * the attacker cannot forge JWTs for any container.
 *
 * @returns { privateKey, publicKey } as PEM strings
 */
export function generateSidecarKeyPair(): {
  privateKey: string;
  publicKey: string;
} {
  const { privateKey, publicKey } = nodeCrypto().generateKeyPairSync(
    "ed25519",
    {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    },
  );
  return { privateKey, publicKey };
}

/**
 * Issue a sidecar access token (JWT) using Ed25519 signing.
 * Scoped to a specific container via the required `cid` claim.
 *
 * @param privateKey - Ed25519 private key (PEM). If not provided, falls back to HMAC.
 * @param hmacFallbackSecret - HMAC secret for backward compat (used when no Ed25519 key)
 * @param payload - Token payload with container ID
 * @param ttlMinutes - Token TTL in minutes
 */
export function issueSidecarAccessToken(
  privateKey: string,
  payload: {
    sub: string;
    pid: string;
    cid: string;
    sid?: string;
    /**
     * Capability allowlist. When present, the token is restricted to
     * routes whose required capability is in this list, as enforced by the
     * sidecar-auth policy layer. Absent = full scope (legacy
     * orchestrator-internal tokens).
     */
    cap?: SidecarCapability[];
  },
  ttlMinutes: number,
): string {
  if (!privateKey.includes("PRIVATE KEY")) {
    throw new Error(
      "issueSidecarAccessToken requires an Ed25519 private key (PEM). " +
        "HMAC fallback has been removed — generate a key pair with generateSidecarKeyPair().",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  // jti (JWT ID) enables token revocation — orchestrator adds jti to blocklist
  // on sandbox delete, sidecar checks blocklist on every request.
  const { randomBytes, sign } = nodeCrypto();
  const jti = `${payload.cid}:${now}:${randomBytes(8).toString("hex")}`;
  const fullPayload = {
    ...payload,
    typ: "sidecar" as const,
    jti,
    iat: now,
    exp: now + ttlMinutes * 60,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${jwtHeaderEddsa()}.${encodedPayload}`;
  const signature = base64UrlEncode(
    sign(null, textEncoder.encode(data), privateKey),
  );
  return `${data}.${signature}`;
}

/**
 * Verify a sidecar JWT using Ed25519 public key. Rejects non-EdDSA tokens.
 * Returns decoded payload on success, null on failure.
 */
export function verifySidecarToken(
  token: string,
  publicKey: string,
  containerId: string,
): {
  sub: string;
  pid: string;
  cid: string;
  sid?: string;
  typ: string;
  jti?: string;
  exp: number;
  cap?: SidecarCapability[];
} | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const headerJson = base64UrlDecode(parts[0]);
    const header = JSON.parse(headerJson);
    if (header.alg !== "EdDSA") return null;

    // SECURITY: verify signature BEFORE inspecting claims.
    // Parsing claims before verification creates a timing oracle that
    // leaks valid container IDs via early-return timing differences.
    const data = `${parts[0]}.${parts[1]}`;
    const signatureBuffer = base64UrlToBytes(parts[2]);
    const valid = nodeCrypto().verify(
      null,
      textEncoder.encode(data),
      publicKey,
      signatureBuffer,
    );
    if (!valid) return null;

    // Signature verified — now safe to parse and inspect claims
    const payload = JSON.parse(base64UrlDecode(parts[1]));

    if (payload.typ !== "sidecar") return null;
    if (typeof payload.jti !== "string" || payload.jti.length === 0) {
      return null;
    }
    const exactContainerMatch = payload.cid === containerId;
    const shortDockerIdMatch = isDockerShortIdMatch(payload.cid, containerId);
    if (!exactContainerMatch && !shortDockerIdMatch) return null;

    // Require exp — tokens without expiration are rejected (no immortal tokens)
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) return null;

    // Require non-empty sub and cid
    if (typeof payload.sub !== "string" || payload.sub.length === 0)
      return null;

    return payload;
  } catch {
    return null;
  }
}

function isDockerShortIdMatch(
  payloadCid: unknown,
  containerId: unknown,
): boolean {
  if (typeof payloadCid !== "string" || typeof containerId !== "string") {
    return false;
  }
  if (!/^[a-f0-9]{64}$/i.test(payloadCid)) {
    return false;
  }
  if (!/^[a-f0-9]{12}$/i.test(containerId)) {
    return false;
  }
  return payloadCid.startsWith(containerId);
}

/**
 * Check if a token payload is session-scoped.
 * Session-scoped tokens have a sid claim and no projectId/projectIds.
 */
export function isSessionScopedToken(
  payload: ReadTokenPayload,
): payload is SessionScopedTokenPayload {
  return (
    "sid" in payload &&
    typeof payload.sid === "string" &&
    payload.sid.length > 0 &&
    !("projectId" in payload && payload.projectId) &&
    !("projectIds" in payload && payload.projectIds)
  );
}

/**
 * Check if a token payload is project-scoped.
 * Project-scoped tokens have a projectId claim and no sid/projectIds.
 */
export function isProjectScopedToken(
  payload: ReadTokenPayload,
): payload is ProjectScopedTokenPayload {
  return (
    "projectId" in payload &&
    typeof payload.projectId === "string" &&
    payload.projectId.length > 0 &&
    !("sid" in payload && payload.sid) &&
    !("projectIds" in payload && payload.projectIds)
  );
}

/**
 * Check if a token payload is batch-scoped.
 * Batch-scoped tokens have a projectIds claim and no sid/projectId.
 */
export function isBatchScopedToken(
  payload: ReadTokenPayload,
): payload is BatchScopedTokenPayload {
  return (
    "projectIds" in payload &&
    Array.isArray(payload.projectIds) &&
    payload.projectIds.length > 0 &&
    !("sid" in payload && payload.sid) &&
    !("projectId" in payload && payload.projectId)
  );
}

/**
 * Get the scope of a token payload.
 * Returns null if the token has an invalid/ambiguous scope.
 */
export function getTokenScope(payload: ReadTokenPayload): TokenScope | null {
  if (isSessionScopedToken(payload)) return "session";
  if (isProjectScopedToken(payload)) return "project";
  if (isBatchScopedToken(payload)) return "batch";
  return null;
}

/**
 * Validate that a token payload has exactly one valid scope.
 * Returns an error message if invalid, null if valid.
 */
export function validateTokenScope(payload: ReadTokenPayload): string | null {
  const hasSid = "sid" in payload && payload.sid;
  const hasProjectId = "projectId" in payload && payload.projectId;
  const hasProjectIds =
    "projectIds" in payload &&
    Array.isArray(payload.projectIds) &&
    payload.projectIds.length > 0;

  const scopeCount = [hasSid, hasProjectId, hasProjectIds].filter(
    Boolean,
  ).length;

  if (scopeCount === 0) {
    return "Token must have one of: sid (session), projectId (project), or projectIds (batch)";
  }

  if (scopeCount > 1) {
    return "Token cannot have multiple scope claims (sid, projectId, projectIds are mutually exclusive)";
  }

  return null;
}

/**
 * Decode a JWT without verification (to extract claims for lookup).
 * Returns null if the token is malformed.
 */
export function decodeToken(token: string): ReadTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return payload as ReadTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Verify a read token against a product's signing secrets.
 *
 * @param token - The JWT token to verify
 * @param product - Product auth info containing secrets
 */
export function verifyReadToken(
  token: string,
  product: ProductAuthInfo,
): TokenValidationResult {
  // Check product status
  if (product.status !== "active") {
    return {
      valid: false,
      error: "Product is suspended",
      errorCode: "PRODUCT_SUSPENDED",
    };
  }

  // Parse token
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      valid: false,
      error: "Invalid token format",
      errorCode: "TOKEN_INVALID",
    };
  }

  const [header, encodedPayload, signature] = parts;
  const data = `${header}.${encodedPayload}`;

  // Pin algorithm to HS256 — defense-in-depth against alg-confusion
  // attacks that swap a forged header (e.g. `alg: "none"`) onto an
  // otherwise valid token. Fast path: when the header bytes match the
  // canonical `JWT_HEADER` verbatim, we skip the parse. Slow path:
  // decode the header and reject anything whose `alg` claim is not
  // `"HS256"`. Non-canonical-but-valid headers (e.g. `alg: "HS256"`
  // with an extra `kid` claim) fall through to signature verification,
  // which covers the actual header bytes — so any tampering with the
  // header still fails the signature check.
  if (header !== jwtHeader()) {
    let parsedAlg: string | null = null;
    try {
      const decoded = JSON.parse(base64UrlDecode(header)) as Record<
        string,
        unknown
      >;
      if (typeof decoded.alg === "string") parsedAlg = decoded.alg;
    } catch {
      // Header didn't decode cleanly; treat as TOKEN_INVALID below.
    }
    if (parsedAlg !== "HS256") {
      return {
        valid: false,
        error: "Unsupported token algorithm",
        errorCode: "TOKEN_INVALID",
      };
    }
  }

  // Verify signature with current secret
  let signatureValid = verifySignature(
    data,
    signature,
    product.secrets.current.secret,
  );

  // If failed and we have a previous secret in grace period, try it
  if (!signatureValid && product.secrets.previous) {
    if (Date.now() < product.secrets.previous.expires_at) {
      signatureValid = verifySignature(
        data,
        signature,
        product.secrets.previous.secret,
      );
    }
  }

  if (!signatureValid) {
    return {
      valid: false,
      error: "Invalid signature",
      errorCode: "SIGNATURE_INVALID",
    };
  }

  // Parse payload
  let payload: ReadTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return {
      valid: false,
      error: "Invalid token payload",
      errorCode: "TOKEN_INVALID",
    };
  }

  // Check token type
  if (payload.typ !== "read") {
    return {
      valid: false,
      error: "Not a read token",
      errorCode: "TOKEN_WRONG_TYPE",
    };
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    return {
      valid: false,
      error: "Token expired",
      errorCode: "TOKEN_EXPIRED",
    };
  }

  // Check product ID matches
  if (payload.pid !== product.product_id) {
    return {
      valid: false,
      error: "Product ID mismatch",
      errorCode: "TOKEN_INVALID",
    };
  }

  // Validate token scope (must have exactly one of sid, projectId, projectIds)
  const scopeError = validateTokenScope(payload);
  if (scopeError) {
    return {
      valid: false,
      error: scopeError,
      errorCode: "TOKEN_INVALID",
    };
  }

  return {
    valid: true,
    payload,
    scope: getTokenScope(payload) ?? undefined,
  };
}

/**
 * Get time until token expires (in seconds).
 * Returns negative if expired.
 */
export function getTokenTTL(payload: ReadTokenPayload): number {
  const now = Math.floor(Date.now() / 1000);
  return payload.exp - now;
}

/**
 * Check if token is expiring soon (within buffer seconds).
 */
export function isTokenExpiringSoon(
  payload: ReadTokenPayload,
  bufferSeconds = 60,
): boolean {
  return getTokenTTL(payload) <= bufferSeconds;
}

/**
 * Default salt for API key hashing (development only).
 * Production MUST set API_KEY_HASH_SALT environment variable.
 * WARNING: Changing the salt will invalidate all existing API key hashes.
 */
const DEFAULT_API_KEY_SALT = "api_key_hash_salt";

let _saltWarned = false;

/**
 * Get the API key hash salt from environment.
 * Logs a warning if falling back to the weak default (development only).
 */
function getApiKeyHashSalt(): string {
  if (typeof process !== "undefined" && process.env?.API_KEY_HASH_SALT) {
    return process.env.API_KEY_HASH_SALT;
  }
  if (
    !_saltWarned &&
    typeof process !== "undefined" &&
    process.env?.NODE_ENV === "production"
  ) {
    _saltWarned = true;
    console.error(
      "[SECURITY] API_KEY_HASH_SALT not set in production. " +
        "Using weak default salt. Set API_KEY_HASH_SALT to a cryptographically random value.",
    );
  }
  return DEFAULT_API_KEY_SALT;
}

/**
 * Hash an API key for storage/lookup.
 * Uses HMAC-SHA256 for consistent, fast hashing.
 *
 * The salt can be configured via API_KEY_HASH_SALT environment variable.
 * WARNING: Changing the salt will invalidate all existing API key hashes.
 */
export function hashApiKey(apiKey: string): string {
  return nodeCrypto()
    .createHmac("sha256", getApiKeyHashSalt())
    .update(apiKey)
    .digest("hex");
}

/**
 * Hash an API key with an explicit salt.
 * Use this when you need to verify against a specific salt.
 */
export function hashApiKeyWithSalt(apiKey: string, salt: string): string {
  return nodeCrypto().createHmac("sha256", salt).update(apiKey).digest("hex");
}

/**
 * Verify an API key using timing-safe comparison.
 */
export function verifyApiKey(provided: string, stored: string): boolean {
  if (provided.length !== stored.length) {
    return false;
  }
  try {
    return nodeCrypto().timingSafeEqual(
      textEncoder.encode(provided),
      textEncoder.encode(stored),
    );
  } catch {
    return false;
  }
}
