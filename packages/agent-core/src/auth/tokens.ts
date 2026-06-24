/**
 * JWT Token Utilities
 *
 * Token generation and verification for multi-tenant auth.
 * - Read/product tokens: HMAC-SHA256 (symmetric, fast)
 * - Sidecar tokens: Ed25519 (asymmetric — sidecar cannot forge tokens)
 */

import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import type {
  BatchScopedTokenPayload,
  ProductAuthInfo,
  ProjectScopedTokenPayload,
  ReadTokenPayload,
  SessionScopedTokenPayload,
  TokenScope,
  TokenValidationResult,
} from "./types.js";

/**
 * Generate a cryptographically secure random string.
 * @param prefix - Prefix for the generated string (e.g., "orch_prod_")
 * @param bytes - Number of random bytes (default: 32 = 256 bits)
 */
export function generateSecureToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
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
 * Base64URL encode (RFC 7515).
 */
function base64UrlEncode(data: string | Buffer): string {
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Base64URL decode.
 */
function base64UrlDecode(data: string): string {
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  return Buffer.from(
    padded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString();
}

/**
 * Create HMAC-SHA256 signature.
 */
function createSignature(data: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(data).digest());
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
  const expectedBuf = createHmac("sha256", secret).update(data).digest();
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(signature, "base64url");
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
 * JWT header (always the same for our use case).
 */
const JWT_HEADER = base64UrlEncode(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
);

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
  const data = `${JWT_HEADER}.${encodedPayload}`;
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

// Ed25519 JWT header (asymmetric — sidecar cannot forge tokens)
const JWT_HEADER_EDDSA = base64UrlEncode(
  JSON.stringify({ alg: "EdDSA", typ: "JWT" }),
);

/**
 * Capability strings carried in a sidecar token's `cap` claim. The
 * sidecar route allowlist (SIDECAR_CAPABILITY_ROUTES) maps each path
 * prefix to the capability required to access it. Tokens with a `cap`
 * claim are strictly limited to those capabilities; tokens without a
 * `cap` claim are full-scope (legacy orchestrator-internal use).
 *
 * Adding a new capability:
 *   1. Extend this union.
 *   2. Add the path prefix → capability mapping in SIDECAR_CAPABILITY_ROUTES.
 *   3. Mint tokens with the new capability via `issueSidecarAccessToken`.
 */
export type SidecarCapability = "computer_use" | "read" | "debug" | "terminal";

/**
 * Public ↔ capability binding. The sidecar's auth middleware uses this
 * to enforce: a token with a `cap` claim can only call routes whose
 * required capability is in the token's `cap` list. Routes not listed
 * here implicitly require full scope (no `cap` claim, i.e. legacy
 * orchestrator-internal tokens).
 *
 * Order matters — longest prefix wins so `/mcp/x` matches before `/`.
 */
export const SIDECAR_CAPABILITY_ROUTES: ReadonlyArray<{
  prefix: string;
  capability: SidecarCapability;
}> = [
  { prefix: "/mcp", capability: "computer_use" },
  // /computer-use is the direct HTTP shim for Anthropic claude-code's
  // `computer` tool and the OpenAI Responses translator. Gating it on
  // the same capability as /mcp keeps master tokens off this surface
  // and lets the OpenAI dispatcher use cap-scoped JWTs end-to-end.
  { prefix: "/computer-use", capability: "computer_use" },
  // /a11y performs real input dispatch (click-by-ref, type-into-ref via the
  // ComputerUseTool) — the same trust surface as /computer-use. Gate it on the
  // same capability so a computer_use-scoped JWT can drive it end-to-end and
  // full-scope master tokens stay off the input surface. Without this entry the
  // boundary was inverted: the scoped JWT was rejected and the master accepted.
  { prefix: "/a11y", capability: "computer_use" },
  // /debug surfaces process listings, log buffers, port-watcher state,
  // and runtime config. The previous SIDECAR_DEBUG_ENABLED env gate is
  // a deploy-time switch — once set, every authenticated caller (every
  // sandbox-api proxy, every browser read-token) could fingerprint the
  // sidecar. Putting /debug behind a `debug` capability means an
  // operator must mint a scoped token explicitly for diagnostic
  // sessions, and master tokens never see the surface.
  { prefix: "/debug", capability: "debug" },
];

/**
 * Pattern-gated routes, for capabilities that must bind to a SPECIFIC path
 * shape rather than a whole prefix. The terminal/ssh WebSocket upgrade paths
 * are the raw-input interactive surface (keystrokes straight to a PTY / SSH
 * tunnel) — the highest-trust action in the box — so they require a `terminal`
 * capability, while the sibling REST route `/terminals/commands` (one-shot
 * command exec, called by the public SDK + artifact queue) deliberately stays
 * OUT of the gate so a prefix match does not break those callers.
 *
 * Adding a pattern: anchor it (`^…$`) so it cannot over-match a sibling path.
 */
export const SIDECAR_CAPABILITY_ROUTE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  capability: SidecarCapability;
}> = [
  // GET /terminals/{connectionId}/ws — the terminal framebuffer + keystroke WS.
  { pattern: /^\/terminals\/[^/]+\/ws$/, capability: "terminal" },
  // GET /ssh (optional trailing slash) — the raw SSH transport tunnel.
  { pattern: /^\/ssh\/?$/, capability: "terminal" },
];

/**
 * Routes a token with `cap: ["read"]` is allowed to call, with the HTTP
 * methods permitted on each. Used by `box.mintScopedToken({scope:
 * "read-only" | "project" | "session"})` (Issue #913 Gap 1).
 *
 * The "read" capability is intentionally NOT in
 * `SIDECAR_CAPABILITY_ROUTES` — that table maps gated routes that ONLY
 * the matching cap can access. "read" is *additive*: it grants a token
 * access to a narrow allow-list of read routes WITHOUT also denying
 * those same routes to master tokens. Master tokens (cap=undefined)
 * keep reaching every non-gated route as before.
 *
 * Adding a route here: keep it GET-only by default. Mutating methods
 * on a read-token would defeat the "read-only" promise customers rely
 * on when handing the token to browser code.
 */
export const READ_CAPABILITY_ROUTES: ReadonlyArray<{
  prefix: string;
  methods: ReadonlyArray<string>;
}> = [
  // Session reads: list, get, message-read. POST/DELETE/PATCH excluded
  // — those create or destroy state and must use the master bearer.
  { prefix: "/agents/sessions", methods: ["GET"] },
  // SSE event stream — what most browser clients are after.
  { prefix: "/agents/events", methods: ["GET"] },
  // Health + privacy posture — safe meta-introspection.
  { prefix: "/health", methods: ["GET"] },
  { prefix: "/privacy", methods: ["GET"] },
  // Read-only desktop observation. Input dispatch remains gated on
  // `computer_use`; read tokens can only fetch the current framebuffer.
  { prefix: "/computer-use/screenshot", methods: ["GET"] },
];

function isReadCapAllowed(path: string, method: string | undefined): boolean {
  if (!method) return false;
  const m = method.toUpperCase();
  for (const entry of READ_CAPABILITY_ROUTES) {
    if (path === entry.prefix || path.startsWith(`${entry.prefix}/`)) {
      return entry.methods.includes(m);
    }
  }
  return false;
}

/**
 * Returns the capability required to access `path`, or `null` if the
 * route requires full scope (no `cap` claim).
 */
export function requiredCapabilityForPath(
  path: string,
): SidecarCapability | null {
  for (const { pattern, capability } of SIDECAR_CAPABILITY_ROUTE_PATTERNS) {
    if (pattern.test(path)) return capability;
  }
  for (const { prefix, capability } of SIDECAR_CAPABILITY_ROUTES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return capability;
  }
  return null;
}

/**
 * Authorize a verified sidecar token for `path` (and optionally
 * `method`). Returns true iff one of:
 *   - the token has NO `cap` claim (legacy full-scope master) AND the
 *     path is not capability-gated;
 *   - the path is capability-gated and the token's `cap` claim
 *     includes the required capability;
 *   - the token has `cap: ["read"]` (Issue #913 Gap 1 consumer
 *     scoped tokens) AND the path is in `READ_CAPABILITY_ROUTES`
 *     with the request method on the allow-list.
 *
 * Fail-closed semantics:
 *   - An explicit `cap` claim is a scope assertion. Even an empty
 *     array (`cap: []`) means "scoped to no capability" → reject every
 *     request, including admin routes (see harden report 2026-04-26).
 *   - A capability-scoped token CANNOT access non-capability-gated
 *     routes outside its explicit allow-list.
 *
 * `method` defaults to undefined for backwards compatibility — callers
 * that don't pass it will fail-closed for the read-cap allow-list,
 * which matches the old behavior (read-cap didn't exist).
 */
export function authorizeSidecarToken(
  payload: { cap?: readonly SidecarCapability[] },
  path: string,
  method?: string,
): boolean {
  const required = requiredCapabilityForPath(path);
  if (payload.cap !== undefined) {
    // "read" cap follows a method-aware allow-list (consumer-scoped
    // tokens for browser code). It does NOT participate in the gated-
    // route table — that table is fail-closed and reserved for
    // capabilities like computer_use.
    if (payload.cap.includes("read") && isReadCapAllowed(path, method)) {
      return true;
    }
    // Explicit scope claim — only authorize capability-gated routes whose
    // required capability is present in the claim (exact match). Empty array
    // → never authorized.
    return required !== null && payload.cap.includes(required);
  }
  // No `cap` claim: legacy full-scope orchestrator-internal token.
  // Capability-gated routes still reject these (the master token must
  // never be presented as a capability credential).
  return required === null;
}

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
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
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
     * routes whose required capability is in this list (see
     * SIDECAR_CAPABILITY_ROUTES). Absent = full scope (legacy
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
  const jti = `${payload.cid}:${now}:${randomBytes(8).toString("hex")}`;
  const fullPayload = {
    ...payload,
    typ: "sidecar" as const,
    jti,
    iat: now,
    exp: now + ttlMinutes * 60,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${JWT_HEADER_EDDSA}.${encodedPayload}`;
  const signature = base64UrlEncode(sign(null, Buffer.from(data), privateKey));
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

    const headerJson = Buffer.from(parts[0], "base64url").toString("utf-8");
    const header = JSON.parse(headerJson);
    if (header.alg !== "EdDSA") return null;

    // SECURITY: verify signature BEFORE inspecting claims.
    // Parsing claims before verification creates a timing oracle that
    // leaks valid container IDs via early-return timing differences.
    const data = `${parts[0]}.${parts[1]}`;
    const signatureBuffer = Buffer.from(parts[2], "base64url");
    const valid = verify(null, Buffer.from(data), publicKey, signatureBuffer);
    if (!valid) return null;

    // Signature verified — now safe to parse and inspect claims
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );

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
  if (header !== JWT_HEADER) {
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
  return createHmac("sha256", getApiKeyHashSalt()).update(apiKey).digest("hex");
}

/**
 * Hash an API key with an explicit salt.
 * Use this when you need to verify against a specific salt.
 */
export function hashApiKeyWithSalt(apiKey: string, salt: string): string {
  return createHmac("sha256", salt).update(apiKey).digest("hex");
}

/**
 * Verify an API key using timing-safe comparison.
 */
export function verifyApiKey(provided: string, stored: string): boolean {
  if (provided.length !== stored.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(stored));
  } catch {
    return false;
  }
}
