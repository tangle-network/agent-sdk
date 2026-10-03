import { AgentExactRunControlRefSchema, type AgentExactRunControlRef } from "@tangle-network/agent-interface";
import { EvidenceJsonArray } from "./tangle-evidence-json.js";
import { sameRunControlRef } from "./tangle-session-control.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Recover callers from server admission frames, never from bare native attempt IDs. */
export async function retainedCaptureAttribution(
  events: readonly unknown[],
  anchor: AgentExactRunControlRef,
  signal?: AbortSignal,
): Promise<{ controlRefs: AgentExactRunControlRef[]; missing: string[] }> {
  const refs = new Map<string, AgentExactRunControlRef>();
  const invalid = new Set<string>();
  const missing: string[] = [];
  let count = 0;
  const reject = (id: string, reason: string) => {
    invalid.add(id);
    refs.delete(id);
    missing.push(`Retained caller attribution for execution ${id}: ${reason}`);
  };
  for (const value of events) {
    const entry = record(value);
    const metadata = record(entry?.metadata);
    if (!entry || !metadata || typeof metadata.executionId !== "string" ||
        metadata.sessionId !== anchor.sessionId) throw new Error("Retained admission buffer names another session");
    const executionId = metadata.executionId;
    const frames = entry.frames instanceof EvidenceJsonArray ? entry.frames.entries() : entry.frames;
    if (!frames || (!Array.isArray(frames) && !(entry.frames instanceof EvidenceJsonArray))) {
      throw new Error("Retained admission frames are unavailable");
    }
    for await (const value of frames as unknown[] | AsyncIterable<unknown>) {
      signal?.throwIfAborted();
      if (++count > 100_000) throw new Error("Retained admission frame limit exceeded");
      const frame = record(value);
      if (frame?.type !== "execution.started") continue;
      const data = record(frame.data);
      const parsed = AgentExactRunControlRefSchema.safeParse(data?.runControlRef);
      if (frame.sessionId !== anchor.sessionId || frame.executionId !== executionId ||
          data?.sessionId !== anchor.sessionId || data.executionId !== executionId || !parsed.success ||
          parsed.data.provider !== anchor.provider || parsed.data.environmentId !== anchor.environmentId ||
          parsed.data.sessionId !== anchor.sessionId || parsed.data.executionId !== executionId) {
        reject(executionId, "missing or mismatched server admission reference");
        continue;
      }
      if (invalid.has(executionId)) continue;
      const previous = refs.get(executionId);
      if (previous && !sameRunControlRef(previous, parsed.data)) {
        reject(executionId, "conflicting server admission references");
        continue;
      }
      refs.set(executionId, parsed.data);
    }
  }
  const admittedAnchor = refs.get(anchor.executionId);
  if (!admittedAnchor || !sameRunControlRef(admittedAnchor, anchor)) {
    missing.push("Retained server admissions do not match the current exact control reference");
    return { controlRefs: [], missing };
  }
  return { controlRefs: [...refs.values()], missing };
}
