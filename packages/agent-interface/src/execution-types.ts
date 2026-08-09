import type { AgentExecutionOutcome, PlanContinuation } from "./plan.js";
import type { InputPart } from "./parts.js";
import type { ProviderConfig } from "./provider-config.js";

export type ToolInvocation = {
  toolName: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  cost?: number;
};

export type ExecutionTiming = {
  startedAt: number;
  completedAt: number;
  durationMs: number;
};

export type AgentExecutionInput = {
  message?: string;
  parts?: InputPart[];
  systemPrompt: string;
  userId?: string;
  traceId?: string;
  sessionId?: string;
  workspaceRoot?: string;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  model?: ProviderConfig["model"];
  turnId?: string;
  planContinuation?: PlanContinuation;
};

export type AgentExecutionResult = {
  outcome: AgentExecutionOutcome;
  text: string;
  toolInvocations: ToolInvocation[];
  reasoning?: string[];
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tokenUsage?: TokenUsage;
  timing?: ExecutionTiming;
};
