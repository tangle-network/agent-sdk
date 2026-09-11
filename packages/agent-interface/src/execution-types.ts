import type { AgentExecutionOutcome, PlanContinuation } from "./plan.js";
import type { InputPart } from "./parts.js";
import type { ProviderConfig } from "./provider-config.js";
import type { InteractionExecutionBinding } from "./interaction-envelope.js";
import type { RequestedInteractions } from "./interaction-permissions.js";
import { z } from "zod";

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

export const TokenUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cost: z.number().finite().nonnegative().optional(),
}) satisfies z.ZodType<TokenUsage>;

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
  /** Exact run coordinates required when this turn can emit interactions. */
  interactionBinding?: InteractionExecutionBinding;
  /** Interaction kinds the provider may originate for this turn. */
  interactions?: RequestedInteractions;
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
