/**
 * Browser-safe Token Utilities
 *
 * Token decoding and inspection that works in both browser and Node.js.
 * Uses only standard APIs (atob/btoa or TextEncoder/TextDecoder).
 */

import type { ReadTokenPayload } from "./types.js";

/**
 * Base64URL decode (browser-safe).
 */
function base64UrlDecode(data: string): string {
  // Add padding if needed
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  // Convert base64url to base64
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");

  // Use atob in browser, Buffer in Node
  if (typeof atob === "function") {
    return atob(base64);
  }
  // Node.js fallback
  return Buffer.from(base64, "base64").toString();
}

/**
 * Decode a JWT without verification (to extract claims for lookup).
 * Returns null if the token is malformed.
 *
 * This is safe to use in browsers - it only parses the token, doesn't verify.
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
