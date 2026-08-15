import {
  type InteractionAnswerSpec,
  InteractionAnswerSpecSchema,
  type InteractionExecutionBinding,
  InteractionKind,
  type InteractionRequest,
  type InteractionRequestMaterial,
  InteractionRequestSchema,
  type InteractionResponseScope,
  interactionRequestDigest,
  PERMISSION_GRANT_FIELD,
  type PermissionGrant,
  permissionAnswerSpec,
  type StreamEvent,
  validateInteractionResponse,
} from "@tangle-network/agent-interface";
import { z } from "zod";

export const DEFAULT_INTERACTION_DECISION_TIMEOUT_MS = 300_000;
export const MAX_INTERACTION_DECISION_TIMEOUT_MS = 2_147_483_647;

export interface InteractionBrokerOptions {
  /** Default wait for an operator response before the declared default applies. */
  decisionTimeoutMs?: number;
}

export const InteractionQuestionSchema = z.object({
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .optional(),
  multiSelect: z.boolean().optional(),
});
export type InteractionQuestion = z.infer<typeof InteractionQuestionSchema>;
const InteractionQuestionsSchema = z.array(InteractionQuestionSchema).min(1);

function checkedTimeout(timeoutMs: number): number {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_INTERACTION_DECISION_TIMEOUT_MS
  ) {
    throw new RangeError(
      `Interaction timeout must be between 1 and ${MAX_INTERACTION_DECISION_TIMEOUT_MS} milliseconds`,
    );
  }
  return timeoutMs;
}

function bindInteractionRequest(
  binding: InteractionExecutionBinding,
  request: Omit<InteractionRequestMaterial, "binding">,
): InteractionRequest {
  const material: InteractionRequestMaterial = {
    ...request,
    binding: { ...binding, interactionId: request.id },
  };
  return InteractionRequestSchema.parse({
    ...material,
    requestDigest: interactionRequestDigest(material),
  });
}

/** Fail-closed coercion: anything other than a known allow grant denies. */
export function coercePermissionGrant(value: unknown): PermissionGrant {
  return value === "allow_once" ||
    value === "allow_session" ||
    value === "allow_always"
    ? value
    : "deny";
}

/** Convert canonical question fields (`q0`, `q1`) to positional answers. */
export function interactionDataToQuestionAnswers(
  data: Record<string, unknown>,
): string[][] {
  const positional: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(data)) {
    const index = /^q(\d+)$/.exec(key)?.[1] ?? key;
    positional[index] = Array.isArray(value)
      ? value.map(String)
      : [String(value)];
  }
  return Object.entries(positional)
    .sort(([left], [right]) =>
      /^\d+$/.test(left) && /^\d+$/.test(right)
        ? Number(left) - Number(right)
        : 0,
    )
    .map(([, value]) => value);
}

/** Build one canonical answer field for each question. */
export function interactionAnswerSpecForQuestions(
  questions: InteractionQuestion[],
): InteractionAnswerSpec {
  const validatedQuestions = InteractionQuestionsSchema.parse(questions);
  return InteractionAnswerSpecSchema.parse({
    fields: validatedQuestions.map((question, index) => {
      const name = `q${index}`;
      if (question.options?.length) {
        return {
          type: "select",
          name,
          label: question.question,
          required: true,
          multi: question.multiSelect === true,
          allowCustom: true,
          options: question.options.map((option) => ({
            value: option.label,
            label: option.label,
            ...(option.description === undefined
              ? {}
              : { description: option.description }),
          })),
        };
      }
      return {
        type: "text",
        name,
        label: question.question,
        required: true,
      };
    }),
  });
}

type PendingPermission = {
  request: InteractionRequest;
  settle: (grant: PermissionGrant) => void;
};

type PendingQuestion = {
  request: InteractionRequest;
  settle: (answers: string[][] | null) => void;
};

type InteractionEventSink = (event: StreamEvent) => unknown;

function responseId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const id = Reflect.get(response, "id");
  return typeof id === "string" ? id : undefined;
}

function matchesExecution(
  request: InteractionRequest,
  binding: InteractionExecutionBinding,
): boolean {
  const actual = request.binding;
  return (
    actual.runId === binding.runId &&
    actual.provider === binding.provider &&
    actual.environmentId === binding.environmentId &&
    actual.sessionId === binding.sessionId &&
    actual.executionId === binding.executionId
  );
}

/**
 * One interaction round-trip for every runner adapter.
 *
 * A runner emits a request and waits here. The UI returns a canonical response.
 * The first response, timeout, or session teardown settles the request.
 */
export class InteractionBroker {
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly decisionTimeoutMs: number;

  constructor(options: InteractionBrokerOptions = {}) {
    this.decisionTimeoutMs = checkedTimeout(
      options.decisionTimeoutMs ?? DEFAULT_INTERACTION_DECISION_TIMEOUT_MS,
    );
  }

  private hasPendingInteraction(id: string): boolean {
    return (
      this.pendingPermissions.has(id) || this.pendingQuestions.has(id)
    );
  }

  /** Emit a permission request and wait for its decision. */
  request(opts: {
    id: string;
    sessionId: string;
    binding: InteractionExecutionBinding;
    toolName: string;
    input?: unknown;
    allowlistGrant: PermissionGrant;
    timeoutMs?: number;
    signal?: AbortSignal;
    emit?: InteractionEventSink;
  }): Promise<PermissionGrant> {
    if (
      opts.binding.sessionId !== opts.sessionId ||
      this.hasPendingInteraction(opts.id)
    ) {
      return Promise.resolve("deny");
    }

    const timeoutMs = checkedTimeout(
      opts.timeoutMs ?? this.decisionTimeoutMs,
    );
    const responseScopes: InteractionResponseScope[] =
      opts.allowlistGrant === "allow_always"
        ? ["interaction", "session", "persistent"]
        : opts.allowlistGrant === "allow_session"
          ? ["interaction", "session"]
          : ["interaction"];
    const request = bindInteractionRequest(opts.binding, {
      id: opts.id,
      kind: InteractionKind.Permission,
      title: `Allow tool "${opts.toolName}"?`,
      subject: {
        type: "tool",
        toolName: opts.toolName,
        ...(opts.input === undefined ? {} : { input: opts.input }),
      },
      answerSpec: permissionAnswerSpec({ responseScopes }),
      responseScopes,
      default:
        opts.allowlistGrant === "deny"
          ? { outcome: "declined" }
          : {
              outcome: "accepted",
              data: { [PERMISSION_GRANT_FIELD]: [opts.allowlistGrant] },
            },
      timeoutMs,
      onTimeout: "default",
    });

    return new Promise<PermissionGrant>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => settle("deny");
      const settle = (grant: PermissionGrant) => {
        if (!this.pendingPermissions.delete(opts.id)) return;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        resolve(grant);
      };
      this.pendingPermissions.set(opts.id, {
        request,
        settle,
      });
      if (!opts.emit) {
        settle(opts.allowlistGrant);
        return;
      }
      timer = setTimeout(() => settle(opts.allowlistGrant), timeoutMs);
      if (opts.signal?.aborted) {
        settle("deny");
        return;
      }
      opts.signal?.addEventListener("abort", abort, { once: true });
      if (opts.signal?.aborted) {
        settle("deny");
        return;
      }
      try {
        void Promise.resolve(opts.emit({ type: "interaction", request })).catch(
          () => settle(opts.allowlistGrant),
        );
      } catch {
        settle(opts.allowlistGrant);
      }
    });
  }

  /** Resolve a pending permission. Invalid or excessive grants deny. */
  respond(response: unknown): boolean {
    const id = responseId(response);
    if (!id) return false;
    const entry = this.pendingPermissions.get(id);
    if (!entry) return false;
    const validation = validateInteractionResponse(entry.request, response);
    if (!validation.ok || validation.response.outcome !== "accepted") {
      entry.settle("deny");
      return true;
    }
    const raw = validation.response.data?.[PERMISSION_GRANT_FIELD];
    const selected =
      Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
    entry.settle(coercePermissionGrant(selected));
    return true;
  }

  /** Emit a question and wait for positional answers. */
  requestQuestion(opts: {
    id: string;
    sessionId: string;
    binding: InteractionExecutionBinding;
    questions: InteractionQuestion[];
    timeoutMs?: number;
    signal?: AbortSignal;
    emit?: InteractionEventSink;
  }): Promise<string[][] | null> {
    if (
      opts.binding.sessionId !== opts.sessionId ||
      this.hasPendingInteraction(opts.id)
    ) {
      return Promise.resolve(null);
    }

    const timeoutMs = checkedTimeout(
      opts.timeoutMs ?? this.decisionTimeoutMs,
    );
    const request = bindInteractionRequest(opts.binding, {
      id: opts.id,
      kind: InteractionKind.Question,
      title: opts.questions[0]?.question ?? "Question",
      answerSpec: interactionAnswerSpecForQuestions(opts.questions),
      default: { outcome: "cancelled" },
      timeoutMs,
      onTimeout: "default",
    });

    return new Promise<string[][] | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => settle(null);
      const settle = (answers: string[][] | null) => {
        if (!this.pendingQuestions.delete(opts.id)) return;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        resolve(answers);
      };
      this.pendingQuestions.set(opts.id, {
        request,
        settle,
      });
      if (!opts.emit) {
        settle(null);
        return;
      }
      timer = setTimeout(() => settle(null), timeoutMs);
      if (opts.signal?.aborted) {
        settle(null);
        return;
      }
      opts.signal?.addEventListener("abort", abort, { once: true });
      if (opts.signal?.aborted) {
        settle(null);
        return;
      }
      try {
        void Promise.resolve(opts.emit({ type: "interaction", request })).catch(
          () => settle(null),
        );
      } catch {
        settle(null);
      }
    });
  }

  /** Resolve a pending question. Invalid, declined, and cancelled replies return null. */
  respondQuestion(response: unknown): boolean {
    const id = responseId(response);
    if (!id) return false;
    const entry = this.pendingQuestions.get(id);
    if (!entry) return false;
    const validation = validateInteractionResponse(entry.request, response);
    if (!validation.ok) {
      entry.settle(null);
      return true;
    }
    const validatedResponse = validation.response;
    entry.settle(
      validatedResponse.outcome === "accepted"
        ? interactionDataToQuestionAnswers(validatedResponse.data ?? {})
        : null,
    );
    return true;
  }

  /** Fail closed every request that belongs to one session. */
  failSession(sessionId: string): void {
    for (const entry of this.pendingPermissions.values()) {
      if (entry.request.binding.sessionId === sessionId) entry.settle("deny");
    }
    for (const entry of this.pendingQuestions.values()) {
      if (entry.request.binding.sessionId === sessionId) entry.settle(null);
    }
  }

  /** Fail closed only the requests from one exact provider execution. */
  failExecution(binding: InteractionExecutionBinding): void {
    for (const entry of this.pendingPermissions.values()) {
      if (matchesExecution(entry.request, binding)) entry.settle("deny");
    }
    for (const entry of this.pendingQuestions.values()) {
      if (matchesExecution(entry.request, binding)) entry.settle(null);
    }
  }
}
