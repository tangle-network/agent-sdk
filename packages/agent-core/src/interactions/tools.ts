import { randomUUID } from "node:crypto";
import type {
  DurablePlan,
  InteractionExecutionBinding,
  StreamEvent,
} from "@tangle-network/agent-interface";
import type {
  InteractionBroker,
  InteractionQuestion,
} from "./broker.js";

/** Claude Code permission prompt callback. */
export type PermissionPromptBridge = (request: {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  operationId: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

/** Question callback. Null means that no answer was provided. */
export type AskUserBridge = (request: {
  questions: InteractionQuestion[];
  operationId?: string;
  signal?: AbortSignal;
}) => Promise<string[][] | null>;

/** Generic action approval callback. */
export type RequestPermissionBridge = (request: {
  tool_name: string;
  input: Record<string, unknown>;
  operationId?: string;
  signal?: AbortSignal;
}) => Promise<{ allowed: boolean; message?: string }>;

/** Durable plan submission callback. */
export type RequestPlanBridge = (request: {
  plan: string;
  sourceToolCallId: string;
}) => Promise<DurablePlan>;

export interface BrokerInteractionTools {
  askUser: AskUserBridge;
  requestPermission: RequestPermissionBridge;
  onStop: () => void;
}

/** Bind generic interaction tools to one broker session. */
export function brokerInteractionTools(
  broker: InteractionBroker,
  options: {
    sessionId: string;
    binding: InteractionExecutionBinding;
    timeoutMs?: number;
    emit?: (event: StreamEvent) => unknown;
  },
): BrokerInteractionTools {
  return {
    askUser: (request) =>
      broker.requestQuestion({
        id: request.operationId ?? randomUUID(),
        sessionId: options.sessionId,
        binding: options.binding,
        questions: request.questions,
        timeoutMs: options.timeoutMs,
        signal: request.signal,
        emit: options.emit,
      }),
    requestPermission: async (request) => {
      const grant = await broker.request({
        id: request.operationId ?? randomUUID(),
        sessionId: options.sessionId,
        binding: options.binding,
        toolName: request.tool_name,
        input: request.input,
        allowlistGrant: "deny",
        timeoutMs: options.timeoutMs,
        signal: request.signal,
        emit: options.emit,
      });
      return { allowed: grant !== "deny" };
    },
    onStop: () => broker.failExecution(options.binding),
  };
}
