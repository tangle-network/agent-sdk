import type { TokenUsage } from "./execution-types.js";
import type { InteractionRequest } from "./interaction.js";
import type { DurablePlan } from "./plan.js";
import type { Part } from "./parts.js";

export type MessagePartUpdatedEvent = {
  type: "message.part.updated";
  part: Part;
  delta?: string;
};

export type StreamStatus =
  | "started"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export type ChildTaskStatus =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * One observed update of a provider-native child task: a subagent, worker, or
 * delegated task that the runner started inside the same run.
 *
 * Identity rules:
 * - `childId` is the provider's stable identifier for the child task. Every
 *   update of one child repeats the same `childId`. A provider that cannot
 *   report a stable `childId` emits no `child-task` event.
 * - `parentChildId` names the parent child task. It is absent when the parent
 *   is the run itself.
 * - `sourceEventId` is the provider's identifier for this exact update. Two
 *   events with the same `sourceEventId` are the same update, so a consumer
 *   applies the first and ignores the rest during replay or reconnect.
 * - Identity never depends on `raw`. `raw` is an opaque, bounded copy of
 *   provider fields that have no canonical position.
 *
 * Certainty rules:
 * - `time.ended` and `terminalReason` are present only with a terminal status
 *   (`completed`, `failed`, `cancelled`).
 * - `time.updated` and `time.ended` are never earlier than `time.started`.
 *
 * Dedupe example for a consumer that rebuilds the child tree from a replayed
 * stream. Live and replayed streams produce the same tree because identity
 * comes only from `childId`, `parentChildId`, and `sourceEventId`:
 *
 * ```ts
 * const applied = new Set<string>();
 * const children = new Map<string, ChildTaskEvent>();
 * for (const event of events) {
 *   if (event.type !== "child-task") continue;
 *   if (applied.has(event.sourceEventId)) continue;
 *   applied.add(event.sourceEventId);
 *   children.set(event.childId, event);
 * }
 * ```
 */
export type ChildTaskEvent = {
  type: "child-task";
  childId: string;
  parentChildId?: string;
  status: ChildTaskStatus;
  title?: string;
  /** Epoch milliseconds reported by the provider. */
  time: { started: number; updated: number; ended?: number };
  /** Runner that executes the child, for example `claude-code`. */
  runner?: string;
  model?: string;
  usage?: TokenUsage;
  terminalReason?: string;
  sourceEventId: string;
  raw?: Record<string, unknown>;
};

export type StreamEvent =
  | MessagePartUpdatedEvent
  | {
      type: "tool-heartbeat";
      toolName: string;
      partId: string;
      elapsedMs: number;
    }
  | {
      type: "tool-slow";
      toolName: string;
      partId: string;
      elapsedMs: number;
      thresholdMs: number;
    }
  | {
      type: "model-processing";
      phase: "tool-result" | "generating" | "thinking";
      toolName?: string;
      elapsedMs?: number;
    }
  | {
      type: "status";
      status: StreamStatus;
      detail?: string;
    }
  | {
      type: "warning";
      code: string;
      message: string;
    }
  | {
      type: "raw";
      backend: string;
      event: unknown;
    }
  | {
      type: "session.updated";
      sessionId: string;
      title?: string;
      time?: { created?: number; updated?: number };
    }
  | {
      type: "interaction";
      request: InteractionRequest;
    }
  | {
      type: "interaction.cancel";
      id: string;
      reason?: string;
    }
  | {
      type: "plan.submitted";
      plan: DurablePlan;
    }
  | ChildTaskEvent;
