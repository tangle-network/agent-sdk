/**
 * Node-only primitives. Kept off the root entry so browser bundles of
 * `@tangle-network/agent-core` never pull in `node:crypto`.
 */
import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of a string or bytes. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Quote one argument for a POSIX shell: single quotes, embedded `'` as `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
