/**
 * Shared Event Types
 *
 * Type definitions for events across the SDK.
 * Uses message.part.updated as the single canonical event for all content.
 *
 * Part types (TextPart, ToolPart, ReasoningPart, FilePart, ToolState)
 * are re-exported from @tangle-network/agent-interface for consistency.
 */

import { z } from "zod";

// Re-export canonical Part types from agent-interface
export type {
  FilePart,
  Part,
  PartBase,
  ReasoningPart,
  SubtaskPart,
  TextPart,
  ToolPart,
  ToolState,
  ToolStateCompleted,
  ToolStateError,
  ToolStatePending,
  ToolStateRunning,
} from "@tangle-network/agent-interface";

// Re-export part type guards
export {
  isFilePart,
  isReasoningPart,
  isSubtaskPart,
  isTextPart,
  isToolPart,
} from "@tangle-network/agent-interface";

// Agent event types - message.part.updated is the primary content event
export const AgentEventTypeSchema = z.enum([
  "message.part.updated",
  "status",
  "error",
  "heartbeat",
  "connection.init",
  "history.replay.start",
  "history.replay.end",
  "execution.started",
  "execution.completed",
  "execution.failed",
  "session.updated",
  "result",
  "done",
]);

export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

// Base event metadata (agent-core specific - adds sequence tracking)
export interface EventMetadata {
  serverInstanceId: string;
  seq: number;
  prevSeq: number | null;
  sentAt: number;
}

// Import Part type for use in events
import type { Part } from "@tangle-network/agent-interface";

// The primary content event - all text, tool, and reasoning updates
export interface MessagePartUpdatedEvent {
  type: "message.part.updated";
  part: Part;
  delta?: string; // Incremental text change for streaming
  _meta?: EventMetadata;
}

// Status event
export interface StatusEvent {
  type: "status";
  status: "started" | "processing" | "completed" | "failed";
  detail?: string;
  _meta?: EventMetadata;
}

// Error event
export interface ErrorEvent {
  type: "error";
  code?: string;
  message: string;
  details?: unknown;
  _meta?: EventMetadata;
}

// Heartbeat event
export interface HeartbeatEvent {
  type: "heartbeat";
  timestamp?: number;
  _meta?: EventMetadata;
}

// Connection events
export interface ConnectionInitEvent {
  type: "connection.init";
  serverInstanceId?: string;
  streamId?: string;
  initialSeq?: number;
  timestamp?: number;
  _meta?: EventMetadata;
}

// Replay events
export interface ReplayStartEvent {
  type: "history.replay.start";
  executionId?: string;
  sessionId?: string;
  totalEvents?: number;
  status?: string;
}

export interface ReplayEndEvent {
  type: "history.replay.end";
  executionId?: string;
  totalEventsReplayed?: number;
  status?: string;
  continuing?: boolean;
}

// Execution lifecycle events
export interface ExecutionStartedEvent {
  type: "execution.started";
  executionId?: string;
  sessionId?: string;
  timestamp?: number;
}

export interface ExecutionCompletedEvent {
  type: "execution.completed";
  executionId?: string;
  sessionId?: string;
  timestamp?: number;
}

export interface ExecutionFailedEvent {
  type: "execution.failed";
  executionId?: string;
  sessionId?: string;
  error?: string;
  timestamp?: number;
}

// Session update event
export interface SessionUpdatedEvent {
  type: "session.updated";
  sessionId: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

// Result event (final response)
export interface ResultEvent {
  type: "result";
  finalText?: string;
  toolInvocations?: unknown[];
  tokenUsage?: Record<string, unknown>;
  timing?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Done event (stream complete)
export interface DoneEvent {
  type: "done";
  requestId?: string;
}

// Union of all agent events
export type AgentEvent =
  | MessagePartUpdatedEvent
  | StatusEvent
  | ErrorEvent
  | HeartbeatEvent
  | ConnectionInitEvent
  | ReplayStartEvent
  | ReplayEndEvent
  | ExecutionStartedEvent
  | ExecutionCompletedEvent
  | ExecutionFailedEvent
  | SessionUpdatedEvent
  | ResultEvent
  | DoneEvent;

// Terminal event types
export interface TerminalDataEvent {
  type: "terminal.data";
  data: string;
  terminalId: string;
}

export interface TerminalResizeEvent {
  type: "terminal.resize";
  cols: number;
  rows: number;
  terminalId: string;
}

export interface TerminalExitEvent {
  type: "terminal.exit";
  exitCode: number;
  terminalId: string;
}

export type TerminalEvent =
  | TerminalDataEvent
  | TerminalResizeEvent
  | TerminalExitEvent;
