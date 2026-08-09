import type { BackendMessage } from "./backend-message.js";
import type { AgentExecutionResult } from "./execution-types.js";
import type { Part } from "./parts.js";
import type { SdkPlanHost } from "./plan.js";
import type { ProviderConfig } from "./provider-config.js";

export type MemoryEntry = {
  id: string;
  type: "summary" | "fact" | "note";
  content: string;
  createdAt: string;
};

export type MemoryEntryInput = Omit<MemoryEntry, "id" | "createdAt">;

export interface SdkMemoryHost {
  list(sessionId: string): Promise<MemoryEntry[]>;
  remember(sessionId: string, entry: MemoryEntryInput): Promise<void>;
  format(entries: MemoryEntry[]): string;
}

export type ToolExecutionContext = {
  workspaceRoot?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  instruction?: string;
  inputSchema: unknown;
  inputSchemaJson: Record<string, unknown>;
  outputSchema?: unknown;
  outputSchemaJson?: Record<string, unknown>;
  handler: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
};

export interface SdkToolHost {
  buildPromptBlock(): string;
  registerInstruction?(instruction: string, key?: string): void;
  clear?(): void;
  getRegisteredTools(): ToolDefinition[];
}

export interface SdkRecorder {
  recordUserMessage(parts: BackendMessage["parts"]): Promise<void>;
  appendAssistantParts(parts: BackendMessage["parts"]): Promise<void>;
  setSessionId(sessionId?: string): Promise<void>;
  recordAssistantPartUpdate?(part: Part, delta?: string): Promise<void>;
  setTurnId?(turnId: string): void;
  markTurnCompleted?(payload?: {
    result?: Record<string, unknown>;
    [extra: string]: unknown;
  }): Promise<void>;
  markTurnInterrupted?(payload?: {
    reason?: string;
    [extra: string]: unknown;
  }): Promise<void>;
  findCompletedTurn?(turnId: string): Promise<AgentExecutionResult | null>;
}

export type TraceEventInput =
  | {
      type: "message.part.updated";
      part: Part;
      delta?: string;
    }
  | {
      type: "message.updated";
      text?: string;
      finalText?: string;
      tokenUsage?: Record<string, unknown>;
      timing?: Record<string, unknown>;
      toolInvocations?: unknown[];
      metadata?: Record<string, unknown>;
    }
  | {
      type: "error";
      category:
        | "runtime"
        | "syntax"
        | "type"
        | "network"
        | "timeout"
        | "unknown";
      message: string;
      stack?: string;
      code?: string;
      source?: string;
    }
  | { type: "custom"; name: string; data: Record<string, unknown> };

export interface SdkTraceContext {
  addEvent(event: TraceEventInput): void;
  addSignal(signal: string, metadata?: Record<string, unknown>): void;
  complete(metadata?: Record<string, unknown>): void;
  fail(error: string | Error, metadata?: Record<string, unknown>): void;
  trackSubAgent?(childSessionId: string, agentType?: string): void;
}

export type SdkHostServices = {
  memoryHost: SdkMemoryHost;
  toolHost: SdkToolHost;
  planHost: SdkPlanHost;
  recorder: SdkRecorder;
  providerConfig: ProviderConfig;
  traceContext?: SdkTraceContext;
};
