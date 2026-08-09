import type {
  PromptOptions,
  PromptResult,
} from "@tangle-network/sandbox";
import type {
  AgentTurnInput,
  AgentTurnResult,
} from "@tangle-network/agent-interface/environment-provider";
import type { InputPart } from "@tangle-network/agent-interface";
import {
  AgentExactRunControlRefSchema,
  AgentTurnInputSchema,
  ContextTransferReceiptSchema,
  contextTransferResultMatchesRequest,
} from "@tangle-network/agent-interface";
import { tokenUsageFromData } from "./tangle-result-values.js";
import { assertBoundedJson } from "./tangle-contract-safety.js";

export function promptFromTurnInput(input: AgentTurnInput): string | InputPart[] {
  AgentTurnInputSchema.parse(input);
  if (input.parts) return input.parts;
  return input.prompt ?? "";
}

export function executionIdFromTurnInput(input: AgentTurnInput): string | undefined {
  return input.executionId ?? input.controlRef?.executionId;
}

export function promptOptionsFromTurnInput(
  input: AgentTurnInput,
  target: {
    provider: string;
    environmentId: string;
    sessionId?: string;
  },
): PromptOptions {
  if (input.contextTransfer !== undefined) {
    throw new Error(
      "Tangle provider does not yet support portable context transfer",
    );
  }
  if (input.nativeContinuation !== undefined) {
    throw new Error(
      "Tangle provider does not yet support verified native continuation",
    );
  }

  AgentTurnInputSchema.parse(input);
  const controlRef = input.controlRef
    ? AgentExactRunControlRefSchema.parse(input.controlRef)
    : undefined;
  if (controlRef) {
    if (
      controlRef.provider !== target.provider ||
      controlRef.environmentId !== target.environmentId ||
      (target.sessionId !== undefined &&
        controlRef.sessionId !== target.sessionId)
    ) {
      throw new Error("Tangle control reference does not match this target");
    }
    if (controlRef.sessionId === undefined || controlRef.executionId === undefined) {
      throw new Error(
        "Tangle control reference requires exact sessionId and executionId",
      );
    }
    if (controlRef.runId !== controlRef.executionId) {
      throw new Error(
        "Tangle control reference requires runId to equal executionId",
      );
    }
    if (
      input.sessionId !== undefined &&
      input.sessionId !== controlRef.sessionId
    ) {
      throw new Error("Tangle sessionId conflicts with the control reference");
    }
    if (
      input.executionId !== undefined &&
      input.executionId !== controlRef.executionId
    ) {
      throw new Error("Tangle executionId conflicts with the control reference");
    }
  }

  if (input.providerOptions && Object.keys(input.providerOptions).length > 0) {
    throw new Error("Tangle prompt providerOptions are not supported");
  }

  const sessionId = input.sessionId ?? controlRef?.sessionId;
  const executionId = input.executionId ?? controlRef?.executionId;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(executionId ? { executionId } : {}),
    ...(input.lastEventId ? { lastEventId: input.lastEventId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.detach !== undefined ? { detach: input.detach } : {}),
  };
}

type SandboxRunStatus =
  | "success"
  | "failed"
  | "blocked_on_approval"
  | "awaiting_question"
  | "awaiting_plan_decision";

type ValidatedSandboxPromptResult = Record<string, unknown> & {
  success: boolean;
  status: SandboxRunStatus;
  durationMs: number;
  executionId?: string;
};

export function validatedSandboxPromptResult(
  result: PromptResult,
): ValidatedSandboxPromptResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Tangle prompt returned no result object");
  }
  const record = result as unknown as Record<string, unknown>;
  if (
    Object.hasOwn(record, "contextTransferReceipt") &&
    record.contextTransferReceipt === undefined
  ) {
    throw new Error(
      "Tangle prompt result returned a context receipt for a turn that requested no transfer",
    );
  }
  assertBoundedJson(record);
  if (typeof record.success !== "boolean") {
    throw new Error("Tangle prompt result omitted its success status");
  }
  const statuses = new Set<SandboxRunStatus>([
    "success",
    "failed",
    "blocked_on_approval",
    "awaiting_question",
    "awaiting_plan_decision",
  ]);
  if (
    typeof record.status !== "string" ||
    !statuses.has(record.status as SandboxRunStatus)
  ) {
    throw new Error("Tangle prompt result contained an invalid run status");
  }
  if (record.success !== (record.status === "success")) {
    throw new Error(
      "Tangle prompt result success flag conflicts with its run status",
    );
  }
  if (
    typeof record.durationMs !== "number" ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  ) {
    throw new Error("Tangle prompt result contained an invalid duration");
  }
  for (const field of [
    "executionId",
    "response",
    "text",
    "finalText",
    "error",
    "errorCode",
    "traceId",
  ]) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw new Error(`Tangle prompt result contained an invalid ${field}`);
    }
  }
  if (record.executionId === "") {
    throw new Error("Tangle prompt result contained an empty executionId");
  }
  tokenUsageFromData(record);
  return record as ValidatedSandboxPromptResult;
}

/** Statuses that mean the run is waiting for a human, not that it failed. */
const AWAITING_STATUSES = new Set<SandboxRunStatus>([
  "blocked_on_approval",
  "awaiting_question",
  "awaiting_plan_decision",
]);

export function agentTurnResultFromPromptRecord(
  record: ValidatedSandboxPromptResult,
  options: {
    contextTransferRequested?: boolean;
    contextTransferRequest?: import("@tangle-network/agent-interface").ContextTransferRequest;
    sessionId?: string;
  } = {},
): AgentTurnResult {
  const text =
    typeof record.response === "string"
      ? record.response
      : typeof record.text === "string"
        ? record.text
        : typeof record.finalText === "string"
          ? record.finalText
          : "";
  // A receipt with no transfer behind it would let the caller record a handoff
  // that never happened, so it is refused rather than passed through.
  const hasContextTransferReceipt = Object.hasOwn(
    record,
    "contextTransferReceipt",
  );
  if (hasContextTransferReceipt && options.contextTransferRequested !== true) {
    throw new Error(
      "Tangle prompt result returned a context receipt for a turn that requested no transfer",
    );
  }
  const rawContextTransferReceipt = hasContextTransferReceipt
    ? record.contextTransferReceipt
    : undefined;
  const contextTransferReceipt = ContextTransferReceiptSchema.safeParse(
    rawContextTransferReceipt,
  );
  if (hasContextTransferReceipt && !contextTransferReceipt.success) {
    throw new Error("Tangle prompt result contained an invalid context receipt");
  }
  if (
    contextTransferReceipt.success &&
    options.contextTransferRequest !== undefined &&
    !contextTransferResultMatchesRequest(
      options.contextTransferRequest,
      contextTransferReceipt.data,
    )
  ) {
    throw new Error("Tangle prompt result context receipt does not match its request");
  }
  const usage = tokenUsageFromData(record);
  const awaiting = AWAITING_STATUSES.has(record.status);
  return {
    text,
    success: record.success,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(usage ? { usage } : {}),
    // A waiting run is not a terminal failure. Dropping the status here made
    // "the agent is asking you something" indistinguishable from "the turn
    // failed", while the sandbox stayed alive waiting for an answer.
    metadata: {
      status: record.status,
      awaitingInteraction: awaiting,
      terminal: !awaiting,
    },
    ...(contextTransferReceipt.success
      ? { contextTransferReceipt: contextTransferReceipt.data }
      : {}),
  };
}
