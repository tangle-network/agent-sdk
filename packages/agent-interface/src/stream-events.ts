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
    };
