/**
 * Reading a token, on any runtime.
 *
 * Inspecting a token needs no secret, so this half of the token surface is
 * portable: it uses only `atob`, `TextDecoder`, and `Date`, all of which a
 * browser and Node both provide. The server module builds on it rather than
 * keeping a second copy, so `@tangle-network/agent-core/auth` and
 * `@tangle-network/agent-core/auth/browser` cannot read one token two ways.
 */

import type { ReadTokenPayload } from "./types.js";

const textDecoder = new TextDecoder();

/** Base64URL decode (RFC 7515) to raw bytes. */
export function base64UrlToBytes(data: string): Uint8Array {
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Base64URL decode to a UTF-8 string.
 *
 * `atob` answers one byte per code unit, so its result is the raw bytes and
 * not yet text. A claim carrying any non-ASCII character — an account name, a
 * project name, an email display name — is only recovered by decoding those
 * bytes as UTF-8.
 */
export function base64UrlDecode(data: string): string {
  return textDecoder.decode(base64UrlToBytes(data));
}

/**
 * Decode a JWT without verifying it, to read claims for lookup.
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
