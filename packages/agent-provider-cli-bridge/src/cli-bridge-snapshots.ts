import { parseJson } from "./cli-bridge-sse.js";
import { CliBridgeProtocolError } from "./cli-bridge-limits.js";
import { CliBridgeRunIdentityError } from "./cli-bridge-response.js";
import type { CliBridgeRunSnapshot } from "./cli-bridge-types.js";

export function assertCliBridgeRunSnapshotIdentity(
  snapshot: CliBridgeRunSnapshot,
  expectedRunId: string,
): void {
  if (snapshot.id !== expectedRunId) {
    throw new CliBridgeRunIdentityError();
  }
}

export function runSnapshot(value: string): CliBridgeRunSnapshot {
  return runSnapshotValue(parseJson(value));
}

function runSnapshotValue(
  parsed: Record<string, unknown>,
): CliBridgeRunSnapshot {
  const id = parsed.id;
  const status = parsed.status;
  const terminal = parsed.terminal;
  if (
    typeof id !== "string" ||
    !["running", "done", "error", "cancelled"].includes(String(status)) ||
    typeof terminal !== "boolean"
  ) {
    throw new CliBridgeProtocolError("invalid-json", 0, 0);
  }
  return {
    id,
    status: status as CliBridgeRunSnapshot["status"],
    terminal,
  };
}

export function cancelSnapshot(value: string): CliBridgeRunSnapshot {
  const parsed = parseJson(value);
  if (!parsed.run || typeof parsed.run !== "object") {
    throw new CliBridgeProtocolError("invalid-json", 0, 0);
  }
  return runSnapshotValue(parsed.run as Record<string, unknown>);
}
