import type { AgentCandidateTermination } from "@tangle-network/agent-interface";

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

export function terminationEqual(
  left: AgentCandidateTermination,
  right: AgentCandidateTermination,
): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "exit":
      return a.exitCode === b.exitCode;
    case "timeout":
      return a.timeoutMs === b.timeoutMs;
    case "signal":
      return a.signal === b.signal;
    case "cancelled":
      return true;
    default:
      return false;
  }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("operation aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
