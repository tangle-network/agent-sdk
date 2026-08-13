import { describe, expect, it, vi } from "vitest";
import {
  AgentEnvironmentCapabilitiesSchema,
  type AgentEnvironment,
} from "@tangle-network/agent-interface/environment-provider";
import {
  InteractionAcknowledgementSchema,
  interactionRequestDigest,
  interactionResponseCommandDigest,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionResponseCommand,
  type InteractionSubject,
} from "@tangle-network/agent-interface";
import type { SandboxEvent } from "@tangle-network/sandbox";
import { createTangleProvider } from "./tangle-provider.js";
import {
  capabilitiesForSandbox,
  defaultTangleSandboxCapabilities,
  sandboxCapabilitySupport,
} from "./tangle-capabilities.js";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
  SandboxRuntimeCapabilityDocument,
  SandboxSessionLike,
} from "./tangle-types.js";

const PROVIDER = "tangle-sandbox";
const ENVIRONMENT_ID = "sbx-interactions";
const SESSION_ID = "session-interactions";
const RUN_ID = "run-1";
const EXECUTION_ID = "execution-1";

const PROVING_DEPLOYMENT: SandboxRuntimeCapabilityDocument = {
  schema: 1,
  interactions: { responseDedupe: true },
};

interface SessionCalls {
  answers: Array<Record<string, string[]>>;
  permissions: Array<{ id: string; response: "allow" | "deny" }>;
  approvals: Array<string | undefined>;
  rejections: Array<{ feedback: string; planId?: string }>;
  deletes: number;
}

interface Harness {
  provider: ReturnType<typeof createTangleProvider>;
  calls: SessionCalls;
  events: SandboxEvent[];
}

function createHarness(options?: {
  deployment?: SandboxRuntimeCapabilityDocument | null;
  omitCapabilities?: boolean;
  capabilitiesError?: unknown;
  deletable?: boolean;
  answer?: (answers: Record<string, string[]>) => Promise<void>;
  respondToPermission?: (
    id: string,
    response: { response: "allow" | "deny" },
  ) => Promise<void>;
}): Harness {
  const calls: SessionCalls = {
    answers: [],
    permissions: [],
    approvals: [],
    rejections: [],
    deletes: 0,
  };
  const events: SandboxEvent[] = [];
  const session: SandboxSessionLike = {
    id: SESSION_ID,
    status: async () => ({ status: "running" }),
    async *events() {
      for (const event of events) yield event;
    },
    result: async () => ({
      success: true,
      finalText: "ok",
      status: "success",
      sessionId: SESSION_ID,
      executionId: EXECUTION_ID,
      durationMs: 1,
    }),
    prompt: async () => ({
      success: true,
      finalText: "ok",
      status: "success",
      sessionId: SESSION_ID,
      executionId: EXECUTION_ID,
      durationMs: 1,
    }),
    interrupt: async () => ({ cancelled: true }),
    answer: async (answers) => {
      if (options?.answer) return options.answer(answers);
      calls.answers.push(answers);
    },
    respondToPermission: async (id, response) => {
      if (options?.respondToPermission) {
        return options.respondToPermission(id, response);
      }
      calls.permissions.push({ id, response: response.response });
    },
    approvePlan: async (planId) => {
      calls.approvals.push(planId);
      return { id: planId ?? "", revision: 1 };
    },
    rejectPlan: async (feedback, planId) => {
      calls.rejections.push({ feedback, ...(planId === undefined ? {} : { planId }) });
      return { id: planId ?? "", revision: 1 };
    },
  };
  const box: SandboxInstanceLike = {
    id: ENVIRONMENT_ID,
    async *streamPrompt() {
      for (const event of events) yield event;
    },
    session: () => session,
    ...(options?.deletable
      ? {
          delete: async () => {
            calls.deletes += 1;
          },
        }
      : {}),
    ...(options?.omitCapabilities
      ? {}
      : {
          capabilities: async () => {
            if (options?.capabilitiesError !== undefined) {
              throw options.capabilitiesError;
            }
            return options === undefined || options.deployment === undefined
              ? PROVING_DEPLOYMENT
              : options.deployment;
          },
        }),
  };
  const client: SandboxClientLike = {
    create: async () => box,
    get: async (id: string) => (id === ENVIRONMENT_ID ? box : null),
  };
  return { provider: createTangleProvider({ client }), calls, events };
}

function interactionRequest(input: {
  id: string;
  kind: string;
  subject?: InteractionSubject;
  fields: InteractionRequest["answerSpec"]["fields"];
  responseScopes?: InteractionRequest["responseScopes"];
}): InteractionRequest {
  const material = {
    id: input.id,
    kind: input.kind,
    title: `${input.kind} ask`,
    ...(input.subject ? { subject: input.subject } : {}),
    answerSpec: { fields: input.fields },
    ...(input.responseScopes ? { responseScopes: input.responseScopes } : {}),
    binding: {
      runId: RUN_ID,
      provider: PROVIDER,
      environmentId: ENVIRONMENT_ID,
      sessionId: SESSION_ID,
      executionId: EXECUTION_ID,
      interactionId: input.id,
    },
  };
  return { ...material, requestDigest: interactionRequestDigest(material) };
}

function interactionEvent(request: InteractionRequest): SandboxEvent {
  return {
    type: "interaction",
    id: `event-${request.id}`,
    data: { request },
  } as unknown as SandboxEvent;
}

function planEvent(planId: string): SandboxEvent {
  return {
    type: "plan.submitted",
    id: `event-${planId}`,
    data: {
      plan: {
        id: planId,
        revision: 1,
        body: "step one",
        submittedAt: "2026-08-13T00:00:00.000Z",
      },
    },
  } as unknown as SandboxEvent;
}

function responseCommand(input: {
  operationId: string;
  interactionId: string;
  response: InteractionResponse;
  binding?: Partial<InteractionResponseCommand["binding"]>;
  requestDigest?: InteractionRequest["requestDigest"];
}): InteractionResponseCommand {
  const binding = {
    runId: RUN_ID,
    provider: PROVIDER,
    environmentId: ENVIRONMENT_ID,
    sessionId: SESSION_ID,
    executionId: EXECUTION_ID,
    interactionId: input.interactionId,
    requestDigest: input.requestDigest ?? EMPTY_DIGEST,
    ...(input.binding ?? {}),
  };
  return {
    operationId: input.operationId,
    binding,
    response: input.response,
    commandDigest: interactionResponseCommandDigest({
      binding,
      response: input.response,
    }),
  };
}

const EMPTY_DIGEST: InteractionRequest["requestDigest"] = `sha256:${"0".repeat(64)}`;

/** The exact run a plan ask must be observed on to be answerable. */
const EXACT_CONTROL_REF = {
  runId: RUN_ID,
  provider: PROVIDER,
  environmentId: ENVIRONMENT_ID,
  sessionId: SESSION_ID,
  executionId: EXECUTION_ID,
  requestDigest: EMPTY_DIGEST,
};

async function observeAsks(
  environment: AgentEnvironment,
  options?: { boundToRun?: boolean },
): Promise<void> {
  for await (const _event of environment.stream({
    prompt: "start",
    sessionId: SESSION_ID,
    ...(options?.boundToRun
      ? { executionId: EXECUTION_ID, controlRef: EXACT_CONTROL_REF }
      : {}),
  })) {
    // Draining the stream is how the adapter observes an outstanding ask.
  }
}

async function environmentWithAsk(
  harness: Harness,
  asks: SandboxEvent[],
  options?: { boundToRun?: boolean },
): Promise<AgentEnvironment> {
  const environment = await harness.provider.create({ profile: { name: "worker" } });
  harness.events.push(...asks);
  await observeAsks(environment, options);
  return environment;
}

describe("tangle interaction responses", () => {
  it("answers a question through SandboxSession.answer", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-question",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);

    const command = responseCommand({
      operationId: "op-question",
      interactionId: request.id,
      requestDigest: request.requestDigest,
      response: { id: request.id, outcome: "accepted", data: { answer: "yes" } },
    });
    const acknowledgement = InteractionAcknowledgementSchema.parse(
      await environment.respondToInteraction?.(command),
    );

    expect(acknowledgement.status).toBe("accepted");
    expect(acknowledgement.operationId).toBe(command.operationId);
    expect(acknowledgement.commandDigest).toBe(command.commandDigest);
    expect(acknowledgement.binding).toEqual(command.binding);
    expect(harness.calls.answers).toEqual([{ answer: ["yes"] }]);
    expect(harness.calls.permissions).toEqual([]);
  });

  it("resolves a permission through SandboxSession.respondToPermission", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-permission",
      kind: "permission",
      subject: { type: "command", command: "rm -rf build" },
      fields: [
        {
          type: "select",
          name: "grant",
          label: "Decision",
          required: true,
          options: [
            { value: "allow_once", label: "Allow once" },
            { value: "deny", label: "Deny" },
          ],
        },
      ],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-permission",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: {
          id: request.id,
          outcome: "accepted",
          data: { grant: ["allow_once"] },
        },
      }),
    );

    expect(acknowledgement?.status).toBe("accepted");
    expect(harness.calls.permissions).toEqual([
      { id: request.id, response: "allow" },
    ]);
  });

  it("denies a permission when the response declines", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-permission-deny",
      kind: "permission",
      fields: [
        {
          type: "select",
          name: "grant",
          label: "Decision",
          required: true,
          options: [
            { value: "allow_once", label: "Allow once" },
            { value: "deny", label: "Deny" },
          ],
        },
      ],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-permission-deny",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: { id: request.id, outcome: "declined" },
      }),
    );

    expect(acknowledgement?.status).toBe("accepted");
    expect(harness.calls.permissions).toEqual([
      { id: request.id, response: "deny" },
    ]);
  });

  it("refuses a permission grant broader than the transport carries", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-permission-session",
      kind: "permission",
      responseScopes: ["interaction", "session"],
      fields: [
        {
          type: "select",
          name: "grant",
          label: "Decision",
          required: true,
          options: [
            { value: "allow_once", label: "Allow once" },
            { value: "allow_session", label: "Allow for this session" },
            { value: "deny", label: "Deny" },
          ],
        },
      ],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-permission-session",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: {
          id: request.id,
          outcome: "accepted",
          data: { grant: ["allow_session"] },
        },
      }),
    );

    expect(acknowledgement?.status).toBe("transport_failure");
    expect(acknowledgement?.retryable).toBe(false);
    expect(acknowledgement?.message).toMatch(/allow_session/);
    expect(harness.calls.permissions).toEqual([]);
  });

  it("approves and rejects a plan through the plan decision methods", async () => {
    const approved = createHarness();
    const approvedEnvironment = await environmentWithAsk(
      approved,
      [planEvent("plan-approve")],
      { boundToRun: true },
    );
    const approval = await approvedEnvironment.respondToInteraction?.(
      responseCommand({
        operationId: "op-plan-approve",
        interactionId: "plan-approve",
        response: { id: "plan-approve", outcome: "accepted" },
      }),
    );
    expect(approval?.status).toBe("accepted");
    expect(approved.calls.approvals).toEqual(["plan-approve"]);

    const rejected = createHarness();
    const rejectedEnvironment = await environmentWithAsk(
      rejected,
      [planEvent("plan-reject")],
      { boundToRun: true },
    );
    const rejection = await rejectedEnvironment.respondToInteraction?.(
      responseCommand({
        operationId: "op-plan-reject",
        interactionId: "plan-reject",
        response: {
          id: "plan-reject",
          outcome: "declined",
          data: { feedback: "split step one" },
        },
      }),
    );
    expect(rejection?.status).toBe("accepted");
    expect(rejected.calls.rejections).toEqual([
      { feedback: "split step one", planId: "plan-reject" },
    ]);
  });

  it("replays one operation and reports an identical later answer as already resolved", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-replay",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);
    const response: InteractionResponse = {
      id: request.id,
      outcome: "accepted",
      data: { answer: "yes" },
    };
    const command = responseCommand({
      operationId: "op-replay",
      interactionId: request.id,
      requestDigest: request.requestDigest,
      response,
    });

    const first = await environment.respondToInteraction?.(command);
    const sameOperation = await environment.respondToInteraction?.(command);
    const sameAnswer = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-replay-second",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response,
      }),
    );

    expect(first?.status).toBe("accepted");
    expect(sameOperation).toEqual(first);
    expect(sameAnswer?.status).toBe("already_resolved_same");
    expect(sameAnswer?.operationId).toBe("op-replay-second");
    // One delivery, three commands: the record answers every retry.
    expect(harness.calls.answers).toHaveLength(1);
  });

  it("reports a different answer to a resolved interaction as a conflict", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-conflict",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);
    await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-conflict-first",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: { id: request.id, outcome: "accepted", data: { answer: "yes" } },
      }),
    );

    const conflicting = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-conflict-second",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: { id: request.id, outcome: "accepted", data: { answer: "no" } },
      }),
    );

    expect(conflicting?.status).toBe("already_resolved_different");
    expect(conflicting?.message).toMatch(/already resolved with response digest sha256:/);
    expect(harness.calls.answers).toHaveLength(1);
  });

  it("reports an unobserved interaction as unknown", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-known",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-unknown",
        interactionId: "ask-never-seen",
        response: { id: "ask-never-seen", outcome: "accepted" },
      }),
    );

    expect(acknowledgement?.status).toBe("unknown_interaction");
    expect(harness.calls.answers).toEqual([]);
  });

  it("separates a stale binding from a foreign run", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-binding",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);
    const response: InteractionResponse = {
      id: request.id,
      outcome: "accepted",
      data: { answer: "yes" },
    };

    const foreignRun = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-foreign-run",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        binding: { runId: "run-other" },
        response,
      }),
    );
    const staleExecution = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-stale-execution",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        binding: { executionId: "execution-other" },
        response,
      }),
    );
    const foreignEnvironment = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-foreign-environment",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        binding: { environmentId: "sbx-other" },
        response,
      }),
    );

    expect(foreignRun?.status).toBe("unknown_run");
    expect(staleExecution?.status).toBe("binding_mismatch");
    expect(foreignEnvironment?.status).toBe("binding_mismatch");
    expect(harness.calls.answers).toEqual([]);
  });

  it("refuses an answer the request's answer spec rejects", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-invalid",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-invalid",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: {
          id: request.id,
          outcome: "accepted",
          data: { answer: "yes", undeclared: "reject me" },
        },
      }),
    );

    expect(acknowledgement?.status).toBe("invalid_response");
    expect(acknowledgement?.message).toMatch(/unknown field "undeclared"/);
    expect(harness.calls.answers).toEqual([]);
  });

  it("reports a withdrawn ask as cancelled", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-cancelled",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
      {
        type: "interaction.cancel",
        id: "event-cancel",
        data: { id: request.id, reason: "run ended" },
      } as unknown as SandboxEvent,
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-cancelled",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: { id: request.id, outcome: "accepted", data: { answer: "yes" } },
      }),
    );

    expect(acknowledgement?.status).toBe("cancelled");
    expect(harness.calls.answers).toEqual([]);
  });

  it("maps the interaction route's refusals onto acknowledgement statuses", async () => {
    const outcomes: Array<{
      failure: Record<string, unknown>;
      status: string;
      message?: RegExp;
      retryable?: boolean;
    }> = [
      {
        failure: {
          status: 409,
          currentState: "already_resolved_different",
        },
        status: "already_resolved_different",
        message: /route refused/,
      },
      {
        failure: { status: 409, currentState: "binding_mismatch" },
        status: "binding_mismatch",
      },
      { failure: { status: 410 }, status: "unknown_interaction" },
      { failure: { status: 404 }, status: "unknown_interaction" },
      { failure: { status: 400 }, status: "invalid_response" },
      {
        failure: { status: 503 },
        status: "transport_failure",
        retryable: true,
      },
      {
        failure: { status: 408, code: "TIMEOUT" },
        status: "transport_failure",
        retryable: true,
      },
      {
        failure: { code: "NETWORK_ERROR" },
        status: "transport_failure",
        retryable: true,
      },
    ];

    for (const outcome of outcomes) {
      const harness = createHarness({
        answer: async () => {
          throw Object.assign(new Error("route refused"), outcome.failure);
        },
      });
      const request = interactionRequest({
        id: "ask-route",
        kind: "question",
        fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
      });
      const environment = await environmentWithAsk(harness, [
        interactionEvent(request),
      ]);
      const acknowledgement = await environment.respondToInteraction?.(
        responseCommand({
          operationId: "op-route",
          interactionId: request.id,
          requestDigest: request.requestDigest,
          response: { id: request.id, outcome: "accepted", data: { answer: "yes" } },
        }),
      );
      expect(acknowledgement?.status).toBe(outcome.status);
      if (outcome.message) expect(acknowledgement?.message).toMatch(outcome.message);
      if (outcome.retryable !== undefined) {
        expect(acknowledgement?.retryable).toBe(outcome.retryable);
      }
      // A refused delivery must not become a local resolution record.
      const retried = await environment.respondToInteraction?.(
        responseCommand({
          operationId: "op-route-retry",
          interactionId: request.id,
          requestDigest: request.requestDigest,
          response: { id: request.id, outcome: "accepted", data: { answer: "yes" } },
        }),
      );
      expect(retried?.status).toBe(outcome.status);
    }
  });

  it("answers through the retained session as well as the environment", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-session",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);
    const session = environment.session?.(SESSION_ID);

    const acknowledgement = await session?.respondToInteraction?.(
      responseCommand({
        operationId: "op-session",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: { id: request.id, outcome: "accepted", data: { answer: "yes" } },
      }),
    );

    expect(acknowledgement?.status).toBe("accepted");
    expect(harness.calls.answers).toEqual([{ answer: ["yes"] }]);
  });

  it("refuses a question answer it cannot aim at the bound ask", async () => {
    const harness = createHarness();
    const older = interactionRequest({
      id: "ask-older",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const newer = interactionRequest({
      id: "ask-newer",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(older),
      interactionEvent(newer),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-newer",
        interactionId: newer.id,
        requestDigest: newer.requestDigest,
        response: { id: newer.id, outcome: "accepted", data: { answer: "newer" } },
      }),
    );

    expect(acknowledgement?.status).toBe("binding_mismatch");
    expect(acknowledgement?.message).toMatch(/ask-older/);
    // The Sandbox question route answers whichever question the session lists
    // first, so an unaimed delivery would answer the older ask.
    expect(harness.calls.answers).toEqual([]);
  });

  it("answers the sole remaining question once the other ask is withdrawn", async () => {
    const harness = createHarness();
    const older = interactionRequest({
      id: "ask-withdrawn",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const newer = interactionRequest({
      id: "ask-remaining",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(older),
      interactionEvent(newer),
      {
        type: "interaction.cancel",
        id: "event-cancel-older",
        data: { id: older.id, reason: "run ended" },
      } as unknown as SandboxEvent,
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-remaining",
        interactionId: newer.id,
        requestDigest: newer.requestDigest,
        response: {
          id: newer.id,
          outcome: "accepted",
          data: { answer: "remaining" },
        },
      }),
    );

    expect(acknowledgement?.status).toBe("accepted");
    expect(harness.calls.answers).toEqual([{ answer: ["remaining"] }]);
  });

  it("answers a retry through a rebuilt environment without delivering twice", async () => {
    const harness = createHarness();
    const request = interactionRequest({
      id: "ask-rebuilt",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);
    const response: InteractionResponse = {
      id: request.id,
      outcome: "accepted",
      data: { answer: "yes" },
    };
    const command = responseCommand({
      operationId: "op-rebuilt",
      interactionId: request.id,
      requestDigest: request.requestDigest,
      response,
    });
    const first = await environment.respondToInteraction?.(command);

    const rebuilt = await harness.provider.get?.(ENVIRONMENT_ID);
    expect(rebuilt).not.toBeNull();
    // The rebuilt object reads the same ask from the session stream again.
    await observeAsks(rebuilt as AgentEnvironment);
    const replayed = await rebuilt?.respondToInteraction?.(command);
    const sameAnswer = await rebuilt?.respondToInteraction?.(
      responseCommand({
        operationId: "op-rebuilt-second",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response,
      }),
    );

    expect(first?.status).toBe("accepted");
    expect(replayed).toEqual(first);
    expect(sameAnswer?.status).toBe("already_resolved_same");
    expect(harness.calls.answers).toHaveLength(1);
  });

  it("refuses a plan response bound to a foreign run", async () => {
    const harness = createHarness();
    const environment = await environmentWithAsk(
      harness,
      [planEvent("plan-foreign")],
      { boundToRun: true },
    );

    const foreignRun = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-plan-foreign-run",
        interactionId: "plan-foreign",
        binding: { runId: "run-somebody-else" },
        response: { id: "plan-foreign", outcome: "accepted" },
      }),
    );
    const foreignExecution = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-plan-foreign-execution",
        interactionId: "plan-foreign",
        binding: { executionId: "execution-other" },
        response: { id: "plan-foreign", outcome: "accepted" },
      }),
    );

    expect(foreignRun?.status).toBe("unknown_run");
    expect(foreignExecution?.status).toBe("binding_mismatch");
    expect(harness.calls.approvals).toEqual([]);
  });

  it("refuses a plan observed on a stream bound to no exact run", async () => {
    const harness = createHarness();
    const environment = await environmentWithAsk(harness, [
      planEvent("plan-unbound"),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-plan-unbound",
        interactionId: "plan-unbound",
        response: { id: "plan-unbound", outcome: "accepted" },
      }),
    );

    expect(acknowledgement?.status).toBe("binding_mismatch");
    expect(acknowledgement?.message).toMatch(/bound to no exact run/);
    expect(harness.calls.approvals).toEqual([]);
  });

  it("reports the runtime's missing outstanding question as unknown", async () => {
    const harness = createHarness({
      answer: async () => {
        throw new Error("No outstanding question to answer for this session");
      },
    });
    const request = interactionRequest({
      id: "ask-gone",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-gone",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: { id: request.id, outcome: "accepted", data: { answer: "yes" } },
      }),
    );

    expect(acknowledgement?.status).toBe("unknown_interaction");
    expect(acknowledgement?.retryable).toBeUndefined();
  });

  it("never calls a rejection without a status retryable", async () => {
    const harness = createHarness({
      answer: async () => {
        throw new Error("socket hang up");
      },
    });
    const request = interactionRequest({
      id: "ask-unattributed",
      kind: "question",
      fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
    });
    const environment = await environmentWithAsk(harness, [
      interactionEvent(request),
    ]);

    const acknowledgement = await environment.respondToInteraction?.(
      responseCommand({
        operationId: "op-unattributed",
        interactionId: request.id,
        requestDigest: request.requestDigest,
        response: { id: request.id, outcome: "accepted", data: { answer: "yes" } },
      }),
    );

    expect(acknowledgement?.status).toBe("transport_failure");
    expect(acknowledgement?.retryable).toBe(false);
  });
});

describe("tangle interaction capability gating", () => {
  it("claims interactions only when the deployment discloses response dedupe", () => {
    const respondingSession: SandboxSessionLike = {
      id: SESSION_ID,
      status: async () => null,
      async *events() {},
      result: async () => ({ success: true, finalText: "", status: "success", durationMs: 1 }),
      prompt: async () => ({ success: true, finalText: "", status: "success", durationMs: 1 }),
      interrupt: async () => ({ cancelled: true }),
      answer: async () => {},
      respondToPermission: async () => {},
      approvePlan: async () => ({}),
      rejectPlan: async () => ({}),
    };
    const box: SandboxInstanceLike = {
      id: ENVIRONMENT_ID,
      async *streamPrompt() {},
      session: () => respondingSession,
    };
    const client: SandboxClientLike = { create: async () => box };
    const claimed = AgentEnvironmentCapabilitiesSchema.parse(
      capabilitiesForSandbox(
        defaultTangleSandboxCapabilities(),
        sandboxCapabilitySupport(box, client, PROVING_DEPLOYMENT),
      ),
    );
    const withheld = capabilitiesForSandbox(
      defaultTangleSandboxCapabilities(),
      sandboxCapabilitySupport(box, client, { schema: 1, interactions: {} }),
    );

    expect(withheld.interactions).toBeUndefined();
    expect(claimed.interactions).toEqual({
      kinds: ["question", "permission", "plan"],
      answerFieldTypes: ["text", "number", "boolean", "select"],
      responseScopes: ["interaction"],
      secretAnswers: false,
      concurrentRequests: false,
      replay: true,
      responseIdempotency: true,
    });
  });

  it("withholds the capability when the document omits the flag", async () => {
    const harness = createHarness({ deployment: { schema: 1, interactions: {} } });
    const environment = await harness.provider.create({ profile: { name: "worker" } });
    expect(environment.respondToInteraction).toBeUndefined();
    expect(environment.session?.(SESSION_ID).respondToInteraction).toBeUndefined();
  });

  it("withholds the capability when capability discovery returns null", async () => {
    const harness = createHarness({ deployment: null });
    const environment = await harness.provider.create({ profile: { name: "worker" } });
    expect(environment.respondToInteraction).toBeUndefined();
  });

  it("withholds the capability when the deployment reports it false", async () => {
    const harness = createHarness({
      deployment: { schema: 1, interactions: { responseDedupe: false } },
    });
    const environment = await harness.provider.create({ profile: { name: "worker" } });
    expect(environment.respondToInteraction).toBeUndefined();
  });

  it("keeps the created sandbox when capability discovery fails", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = createHarness({
        capabilitiesError: Object.assign(new Error("capabilities unavailable"), {
          status: 503,
        }),
        deletable: true,
      });
      const environment = await harness.provider.create({
        profile: { name: "worker" },
      });

      expect(environment.id).toBe(ENVIRONMENT_ID);
      expect(environment.respondToInteraction).toBeUndefined();
      expect(harness.calls.deletes).toBe(0);
      expect(warned).toHaveBeenCalledTimes(1);
      expect(String(warned.mock.calls[0]?.[0])).toContain(ENVIRONMENT_ID);
    } finally {
      warned.mockRestore();
    }
  });

  it("withholds the capability when the SDK predates capability discovery", async () => {
    const harness = createHarness({ omitCapabilities: true });
    const environment = await harness.provider.create({ profile: { name: "worker" } });
    expect(environment.respondToInteraction).toBeUndefined();
  });

  it("never claims interactions at the provider boundary", async () => {
    const harness = createHarness();
    const capabilities = await harness.provider.capabilities();
    expect(capabilities.interactions).toBeUndefined();
  });
});
