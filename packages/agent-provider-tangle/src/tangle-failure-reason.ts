/**
 * Bounded, credential-free summary of one Sandbox transport failure.
 *
 * A transport message carries the request URL, and that URL can carry userinfo
 * or a query token, so no contract payload ever repeats the message. A summary
 * is built from structured error members only: a status is re-emitted as an
 * integer, and a code or an error name is emitted only when it matches a bare
 * identifier, which cannot express a URL, a bearer, or whitespace.
 */

/** Codes and error names must match this to be carried into a reason. */
const BARE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Which transport read one reason describes. */
export type TransportRead =
  | "environment refresh"
  | "placement lookup"
  | "resource usage read"
  | "subscription read"
  | "account usage read"
  | "terminal attach"
  | "terminal acknowledgement"
  | "terminal metadata read"
  | "terminal socket"
  | "interactive start"
  | "interactive status"
  | "interactive attach"
  | "interactive prompt"
  | "interactive stop";

/** Name the read that failed and the cause, with nothing copied from it. */
export function transportFailureReason(read: TransportRead, error: unknown): string {
  return `the Sandbox ${read} failed (${failureCause(error)})`;
}

function failureCause(error: unknown): string {
  if (error === null || typeof error !== "object") return "cause unreported";
  const detail = error as { name?: unknown; code?: unknown; status?: unknown };
  const name = bareIdentifier(detail.name);
  if (name === "AbortError") return "aborted";
  if (name === "TimeoutError") return "timed out";
  const status = httpStatus(detail.status);
  if (status !== undefined) return `HTTP ${status}`;
  const code = bareIdentifier(detail.code);
  if (code !== undefined) return `code ${code}`;
  // A bare `Error` names no cause beyond the message, which is never carried.
  if (name !== undefined && name !== "Error") return name;
  return "cause unreported";
}

function bareIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && BARE_IDENTIFIER.test(value) ? value : undefined;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}
