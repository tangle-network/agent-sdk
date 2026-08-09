import type { SandboxEvent } from "@tangle-network/sandbox";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import { assertBoundedJson } from "./tangle-contract-safety.js";
import { optionalNonEmptyString } from "./tangle-environment-values.js";
import { tokenUsageFromData } from "./tangle-result-values.js";

export function environmentEventFromSandboxEvent(
  event: SandboxEvent,
  expected: { executionId?: string; sessionId?: string } = {},
): AgentEnvironmentEvent {
  if (!event || typeof event !== "object") {
    throw new Error("Tangle Sandbox emitted a non-object event");
  }
  const record = event as unknown as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.length === 0) {
    throw new Error("Tangle Sandbox event omitted its type");
  }
  if (record.type.length > 512 || record.type.trim() !== record.type) {
    throw new Error("Tangle Sandbox event type exceeded its bound");
  }
  if (
    !record.data ||
    typeof record.data !== "object" ||
    Array.isArray(record.data)
  ) {
    throw new Error("Tangle Sandbox event omitted its object data");
  }
  if (
    record.id !== undefined &&
    (typeof record.id !== "string" ||
      record.id.length === 0 ||
      record.id.length > 512 ||
      record.id.trim() !== record.id)
  ) {
    throw new Error("Tangle Sandbox event contained an invalid event id");
  }
  const data = record.data as Record<string, unknown>;
  assertBoundedRecord(data);
  assertBoundedJson(record);
  if (Object.prototype.hasOwnProperty.call(data, "contextTransferReceipt")) {
    throw new Error(
      "Tangle Sandbox emitted an unsolicited context transfer receipt",
    );
  }
  const eventExecutionId = optionalNonEmptyString(
    data.executionId,
    "Tangle Sandbox event executionId",
  );
  const eventSessionId = optionalNonEmptyString(
    data.sessionId,
    "Tangle Sandbox event sessionId",
  );
  if (
    expected.executionId !== undefined &&
    (eventExecutionId === undefined || eventExecutionId !== expected.executionId)
  ) {
    throw new Error(
      "Tangle exact session event identified a different executionId",
    );
  }
  if (
    expected.sessionId !== undefined &&
    (eventSessionId === undefined || eventSessionId !== expected.sessionId)
  ) {
    throw new Error("Tangle exact session event identified a different sessionId");
  }
  const usage = tokenUsageFromData(data);
  return {
    type: record.type,
    data,
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    // Absent rather than zeroed: an event that reported no usage must not
    // contribute a total to whatever sums these events.
    ...(usage ? { usage } : {}),
    providerEvent: event,
  };
}

function assertBoundedRecord(value: Record<string, unknown>): void {
  if (Object.keys(value).length > 256) {
    throw new Error("Tangle Sandbox event data has too many fields");
  }
  const pending: Array<{ value: unknown; depth: number; leave?: boolean }> = [
    { value, depth: 0 },
  ];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    nodes += 1;
    if (nodes > 8_192) throw new Error("Tangle Sandbox event data has too many JSON nodes");
    const current = item.value;
    if (item.leave) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string" || typeof current === "number") {
      if (typeof current === "string" && current.length > 16_384) {
        throw new Error("Tangle Sandbox event data exceeded its string bound");
      }
      if (typeof current === "number" && !Number.isFinite(current)) {
        throw new Error("Tangle Sandbox event data contained a non-finite number");
      }
      continue;
    }
    if (typeof current !== "object" || item.depth >= 16 || ancestors.has(current)) {
      throw new Error("Tangle Sandbox event data exceeded its JSON bound");
    }
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, leave: true });
    if (Array.isArray(current)) {
      if (current.length > 1_024) {
        throw new Error("Tangle Sandbox event data has too many array entries");
      }
      for (const entry of current) pending.push({ value: entry, depth: item.depth + 1 });
      continue;
    }
    if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new Error("Tangle Sandbox event data must be plain JSON");
    }
    const keys = Object.keys(current);
    if (keys.length > 256) throw new Error("Tangle Sandbox event map is too large");
    for (const key of keys) {
      if (key.length > 512) throw new Error("Tangle Sandbox event key is too long");
      pending.push({ value: (current as Record<string, unknown>)[key], depth: item.depth + 1 });
    }
  }
}
