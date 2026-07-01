/**
 * Browser Import Safety
 *
 * `@tangle-network/agent-core`'s root re-exports this token module, so it lands
 * in browser bundles transitively (e.g. via `@tangle-network/sdk-telemetry`).
 * It must stay importable and usable with no global `Buffer` — otherwise the
 * consuming SPA boot-crashes with `ReferenceError: Buffer is not defined`.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  decodeToken,
  generateSidecarKeyPair,
  hashApiKey,
  issueReadToken,
  issueSidecarAccessToken,
  verifyApiKey,
  verifySidecarToken,
} from "../../src/auth/tokens.js";

const SECRET = "orch_sign_browser_safety_secret_long_enough";

describe("auth token module browser import safety", () => {
  const savedBuffer = (globalThis as { Buffer?: unknown }).Buffer;

  afterEach(() => {
    (globalThis as { Buffer?: unknown }).Buffer = savedBuffer;
  });

  it("issues and decodes read tokens with no global Buffer", () => {
    (globalThis as { Buffer?: unknown }).Buffer = undefined;

    const token = issueReadToken(SECRET, { sub: "u", sid: "s", pid: "p" }, 15);
    expect(token.split(".")).toHaveLength(3);

    const payload = decodeToken(token);
    expect(payload?.sub).toBe("u");
    expect((payload as { sid?: string } | null)?.sid).toBe("s");
  });

  it("keeps the HS256 JWT header wire format stable", () => {
    const token = issueReadToken(SECRET, { sub: "u", sid: "s", pid: "p" }, 15);
    // A stable header keeps already-issued tokens verifiable; the base64url
    // rewrite must not change a single byte.
    expect(token.split(".")[0]).toBe("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("round-trips Ed25519 sidecar tokens with no global Buffer", () => {
    (globalThis as { Buffer?: unknown }).Buffer = undefined;

    const { privateKey, publicKey } = generateSidecarKeyPair();
    const token = issueSidecarAccessToken(
      privateKey,
      { sub: "u", pid: "p", cid: "container_123" },
      15,
    );
    expect(verifySidecarToken(token, publicKey, "container_123")?.cid).toBe(
      "container_123",
    );
    expect(verifySidecarToken(token, publicKey, "other_container")).toBeNull();
  });

  it("hashes and verifies API keys with no global Buffer", () => {
    (globalThis as { Buffer?: unknown }).Buffer = undefined;

    const hash = hashApiKey("orch_prod_abc");
    expect(hashApiKey("orch_prod_abc")).toBe(hash);
    expect(verifyApiKey(hash, hash)).toBe(true);
    expect(verifyApiKey(hash, hashApiKey("orch_prod_xyz"))).toBe(false);
  });
});
