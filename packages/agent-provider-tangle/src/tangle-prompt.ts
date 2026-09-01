import type {
  BackendConfig,
  PromptOptions,
  PromptResult,
} from "@tangle-network/sandbox";
import type {
  AgentTurnInput,
  AgentTurnResult,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentExactRunControlRef,
  InputPart,
} from "@tangle-network/agent-interface";
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

  const backend = turnBackendOptions(input);

  const sessionId = input.sessionId ?? controlRef?.sessionId;
  const executionId = input.executionId ?? controlRef?.executionId;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(backend === undefined ? {} : { backend }),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(executionId ? { executionId } : {}),
    ...(controlRef ? { runControlRef: controlRef } : {}),
    ...(input.lastEventId ? { lastEventId: input.lastEventId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.detach !== undefined ? { detach: input.detach } : {}),
  };
}

/**
 * The `BackendConfig` fields the Sandbox prompt options declare.
 *
 * A turn may carry any of them and nothing else. An undeclared field is
 * refused instead of forwarded, because the SDK drops what it does not
 * declare: the turn would then run on different settings with no error
 * anywhere, which is the silent substitution the SDK's own `model` field
 * exists to prevent.
 */
const SANDBOX_BACKEND_FIELD_LIST = [
  "type",
  "profile",
  "model",
  "server",
  "interactions",
  "metadata",
] as const;

const SANDBOX_BACKEND_FIELDS = new Set<string>(SANDBOX_BACKEND_FIELD_LIST);

/**
 * The `BackendConfig["model"]` fields the Sandbox prompt options declare.
 *
 * This is the block that carries per-turn credentials — `authMode: "oauth"`
 * with `authFiles` for a subscription seat — so it is checked field by field
 * rather than passed through as opaque JSON.
 */
const SANDBOX_BACKEND_MODEL_FIELD_LIST = [
  "provider",
  "model",
  "apiKey",
  "baseUrl",
  "maxThinkingTokens",
  "mode",
  "apiKeyEnv",
  "authMode",
  "authFiles",
] as const;

const SANDBOX_BACKEND_MODEL_FIELDS = new Set<string>(
  SANDBOX_BACKEND_MODEL_FIELD_LIST,
);

/**
 * The two lists above are the SDK's field sets, restated as values because a
 * TypeScript type cannot be read at run time. This pin keeps them exact in
 * both directions: a field the SDK adds, renames, or removes fails the build
 * here rather than reaching a caller as a wrong refusal or a silent drop.
 */
type Exhaustive<T extends never> = T;

type SandboxBackendModel = NonNullable<BackendConfig["model"]>;

type UncoveredBackendField = Exhaustive<
  Exclude<keyof BackendConfig, (typeof SANDBOX_BACKEND_FIELD_LIST)[number]>
>;
type StaleBackendField = Exhaustive<
  Exclude<(typeof SANDBOX_BACKEND_FIELD_LIST)[number], keyof BackendConfig>
>;
type UncoveredBackendModelField = Exhaustive<
  Exclude<
    keyof SandboxBackendModel,
    (typeof SANDBOX_BACKEND_MODEL_FIELD_LIST)[number]
  >
>;
type StaleBackendModelField = Exhaustive<
  Exclude<
    (typeof SANDBOX_BACKEND_MODEL_FIELD_LIST)[number],
    keyof SandboxBackendModel
  >
>;

export type SandboxBackendFieldCoverage = [
  UncoveredBackendField,
  StaleBackendField,
  UncoveredBackendModelField,
  StaleBackendModelField,
];

type SandboxPromptBackend = NonNullable<PromptOptions["backend"]>;

/**
 * Read the per-turn backend options a caller sent through `providerOptions`.
 *
 * `AgentTurnInput.providerOptions.backend` is the exact shape agent-runtime
 * emits for a per-turn backend or model override, so refusing it dropped the
 * caller's model, profile, and session credential bundle at the adapter
 * boundary. Every field is checked against what the Sandbox prompt options
 * declare, and the result is bounded JSON the SDK reads once.
 */
export function backendFromTurnProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
): SandboxPromptBackend | undefined {
  if (providerOptions === undefined) return undefined;
  const unsupported = Object.keys(providerOptions).filter(
    (key) => key !== "backend",
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Tangle prompt providerOptions are not supported: ${unsupported.sort().join(", ")}`,
    );
  }
  if (!Object.hasOwn(providerOptions, "backend")) return undefined;
  return sandboxPromptBackend(providerOptions.backend);
}

function sandboxPromptBackend(value: unknown): SandboxPromptBackend {
  const present = plainRecord(value, "Tangle prompt backend options");
  const unsupported = Object.keys(present).filter(
    (key) => !SANDBOX_BACKEND_FIELDS.has(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Tangle prompt backend options are not supported: ${unsupported.sort().join(", ")}`,
    );
  }
  const backend = {
    ...present,
    ...(present.model === undefined
      ? {}
      : { model: sandboxPromptBackendModel(present.model) }),
  };
  assertBoundedJson(backend);
  return backend as SandboxPromptBackend;
}

function sandboxPromptBackendModel(value: unknown): Record<string, unknown> {
  const present = { ...plainRecord(value, "Tangle prompt backend model options") };
  const unsupported = Object.keys(present).filter(
    (key) => !SANDBOX_BACKEND_MODEL_FIELDS.has(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Tangle prompt backend model options are not supported: ${unsupported.sort().join(", ")}`,
    );
  }
  if (present.authFiles !== undefined) {
    present.authFiles = sandboxPromptAuthFiles(present.authFiles);
  }
  return present;
}

function sandboxPromptAuthFiles(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error("Tangle prompt backend authFiles must be an array");
  }
  return value.map((entry) => {
    const file = plainRecord(entry, "Tangle prompt backend auth file");
    const unsupported = Object.keys(file).filter(
      (key) => !["path", "content", "mode"].includes(key),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `Tangle prompt backend auth file fields are not supported: ${unsupported.sort().join(", ")}`,
      );
    }
    if (typeof file.path !== "string" || file.path.length === 0) {
      throw new Error("Tangle prompt backend auth file requires a path");
    }
    if (typeof file.content !== "string") {
      throw new Error("Tangle prompt backend auth file requires string content");
    }
    if (file.mode !== undefined && !Number.isSafeInteger(file.mode)) {
      throw new Error("Tangle prompt backend auth file mode must be an integer");
    }
    return file;
  });
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Combine the turn's requested interaction posture with its backend options.
 *
 * agent-runtime emits both: it maps `backend.interactions` onto the canonical
 * `AgentTurnInput.interactions` and carries the whole backend block through
 * `providerOptions`. The two must agree, and a disagreement is refused rather
 * than resolved by preference, because either answer would run the turn on a
 * posture the caller did not ask for.
 */
function turnBackendOptions(
  input: AgentTurnInput,
): SandboxPromptBackend | undefined {
  const backend = backendFromTurnProviderOptions(input.providerOptions);
  const backendModel = backend?.model?.model;
  if (
    input.model !== undefined &&
    backendModel !== undefined &&
    backendModel !== input.model
  ) {
    throw new Error("Tangle turn model conflicts with its backend model");
  }
  if (input.interactions === undefined) return backend;
  if (backend === undefined) return { interactions: input.interactions };
  if (
    backend.interactions !== undefined &&
    !sameRequestedInteractions(backend.interactions, input.interactions)
  ) {
    throw new Error(
      "Tangle turn interactions conflict with its backend interactions",
    );
  }
  return { ...backend, interactions: input.interactions };
}

function sameRequestedInteractions(
  left: { permission?: boolean; question?: boolean; plan?: boolean },
  right: { permission?: boolean; question?: boolean; plan?: boolean },
): boolean {
  return (["permission", "question", "plan"] as const).every(
    (kind) => (left[kind] ?? false) === (right[kind] ?? false),
  );
}

type SandboxRunStatus =
  | "success"
  | "failed"
  | "blocked_on_approval"
  | "awaiting_question"
  | "awaiting_interaction"
  | "awaiting_plan_decision";

type ValidatedSandboxPromptResult = Record<string, unknown> & {
  success: boolean;
  status: SandboxRunStatus;
  durationMs: number;
  executionId?: string;
};

const SANDBOX_OPTIONAL_RESULT_FIELDS = new Set([
  "executionId",
  "response",
  "error",
  "errorCode",
  "toolInvocations",
  "approval",
  "interaction",
  "question",
  "plan",
  "traceId",
  "usage",
  "costUsd",
]);

export function validatedSandboxPromptResult(
  result: PromptResult,
): ValidatedSandboxPromptResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Tangle prompt returned no result object");
  }
  const source = result as unknown as Record<string, unknown>;
  if (
    Object.hasOwn(source, "contextTransferReceipt") &&
    source.contextTransferReceipt === undefined
  ) {
    throw new Error(
      "Tangle prompt result returned a context receipt for a turn that requested no transfer",
    );
  }
  // The Sandbox SDK materializes absent optional response fields as
  // `undefined`. They were absent on the JSON wire and must stay absent in the
  // provider-neutral result before the strict JSON check runs.
  const record = Object.fromEntries(
    Object.entries(source).filter(
      ([field, value]) =>
        value !== undefined || !SANDBOX_OPTIONAL_RESULT_FIELDS.has(field),
    ),
  );
  assertBoundedJson(record);
  if (typeof record.success !== "boolean") {
    throw new Error("Tangle prompt result omitted its success status");
  }
  const statuses = new Set<SandboxRunStatus>([
    "success",
    "failed",
    "blocked_on_approval",
    "awaiting_question",
    "awaiting_interaction",
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
  "awaiting_interaction",
  "awaiting_plan_decision",
]);

export function agentTurnResultFromPromptRecord(
  record: ValidatedSandboxPromptResult,
  options: {
    contextTransferRequested?: boolean;
    contextTransferRequest?: import("@tangle-network/agent-interface").ContextTransferRequest;
    sessionId?: string;
    controlRef?: AgentExactRunControlRef;
  } = {},
): AgentTurnResult {
  const controlRef = options.controlRef
    ? AgentExactRunControlRefSchema.parse(options.controlRef)
    : undefined;
  if (
    controlRef !== undefined &&
    options.sessionId !== undefined &&
    controlRef.sessionId !== options.sessionId
  ) {
    throw new Error("Tangle prompt result sessionId conflicts with its control reference");
  }
  if (
    controlRef !== undefined &&
    record.executionId !== controlRef.executionId
  ) {
    throw new Error("Tangle prompt result did not confirm its exact executionId");
  }
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
      ...(controlRef
        ? {
            runId: controlRef.runId,
            executionId: controlRef.executionId,
            requestDigest: controlRef.requestDigest,
          }
        : {}),
      status: record.status,
      awaitingInteraction: awaiting,
      terminal: !awaiting,
    },
    ...(contextTransferReceipt.success
      ? { contextTransferReceipt: contextTransferReceipt.data }
      : {}),
  };
}
