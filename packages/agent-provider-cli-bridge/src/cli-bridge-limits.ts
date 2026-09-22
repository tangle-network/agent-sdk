export const CLI_BRIDGE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CLI_BRIDGE_MAX_SSE_FRAME_BYTES = 1 * 1024 * 1024;
export const CLI_BRIDGE_MAX_DECODED_TEXT_BYTES = 8 * 1024 * 1024;
export const CLI_BRIDGE_MAX_EVENTS = 4_096;
export const CLI_BRIDGE_MAX_TOOL_CALLS = 1_024;
export const CLI_BRIDGE_MAX_RESULT_TEXT_BYTES = 4 * 1024 * 1024;
export const CLI_BRIDGE_MAX_RESULT_EVENTS = 4_096;
export const CLI_BRIDGE_MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const CLI_BRIDGE_MAX_ERROR_DETAIL_BYTES = 4_096;

export type CliBridgeProtocolErrorCode =
  | "response-bytes"
  | "frame-bytes"
  | "decoded-text-bytes"
  | "event-count"
  | "tool-call-count"
  | "result-text-bytes"
  | "result-event-count"
  | "result-bytes"
  | "invalid-utf8"
  | "invalid-json"
  | "invalid-body"
  | "unknown-run";

export class CliBridgeProtocolError extends Error {
  constructor(
    readonly code: CliBridgeProtocolErrorCode,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`cli-bridge protocol ${code} limit exceeded`);
    this.name = "CliBridgeProtocolError";
  }
}

export function addLimit(
  current: number,
  addition: number,
  limit: number,
  code: CliBridgeProtocolErrorCode,
): number {
  const next = current + addition;
  if (!Number.isSafeInteger(next) || next > limit) {
    throw new CliBridgeProtocolError(code, limit, next);
  }
  return next;
}

export function assertLimit(
  value: number,
  limit: number,
  code: CliBridgeProtocolErrorCode,
): void {
  if (!Number.isSafeInteger(value) || value > limit) {
    throw new CliBridgeProtocolError(code, limit, value);
  }
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function boundedErrorDetail(value: string): string {
  if (utf8Bytes(value) <= CLI_BRIDGE_MAX_ERROR_DETAIL_BYTES) return value;
  const suffix = "…";
  const contentLimit =
    CLI_BRIDGE_MAX_ERROR_DETAIL_BYTES - utf8Bytes(suffix);
  let end = Math.min(value.length, contentLimit);
  while (end > 0 && utf8Bytes(value.slice(0, end)) > contentLimit) {
    end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

export function preserveRootError(
  root: unknown,
  cleanup: unknown,
  message: string,
): unknown {
  if (sameError(root, cleanup)) return root;
  return new AggregateError([root, cleanup], message);
}

function sameError(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!(left instanceof Error) || !(right instanceof Error)) return false;
  return (
    left.name === right.name &&
    left.message === right.message &&
    sameErrorCause(left.cause, right.cause)
  );
}

function sameErrorCause(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return (
    leftRecord.code === rightRecord.code &&
    leftRecord.message === rightRecord.message
  );
}
