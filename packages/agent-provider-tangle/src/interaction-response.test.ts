import { describe, expect, it } from "vitest";
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
}

interface Harness {
  provider: ReturnType<typeof createTangleProvider>;
  calls: SessionCalls;
  events: SandboxEvent[];
}

function createHarness(options?: {
  deployment?: SandboxRuntimeCapabilityDocument | null;
  omitCapabilities?: boolean;
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
    ...(options?.omitCapabilities
      ? {}
      : {
          capabilities: async () =>
            options === undefined || options.deployment === undefined
              ? PROVING_DEPLOYMENT
              : options.deployment,
        }),
  };
  const client: SandboxClientLike = { create: async () => box };
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

async function environmentWithAsk(
  harness: Harness,
  asks: SandboxEvent[],
): Promise<AgentEnvironment> {
  const environment = await harness.provider.create({ profile: { name: "worker" } });
  harness.events.push(...asks);
  for await (const _event of environment.stream({
    prompt: "start",
    sessionId: SESSION_ID,
  })) {
    // Draining the stream is how the adapter observes an outstanding ask.
  }
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
    const approvedEnvironment = await environmentWithAsk(approved, [
      planEvent("plan-approve"),
    ]);
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
    const rejectedEnvironment = await environmentWithAsk(rejected, [
      planEvent("plan-reject"),
    ]);
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
    }> = [
      {
        failure: {
          status: 409,
          currentState: "already_resolved_different",
          existingResponseDigest: `sha256:${"a".repeat(64)}`,
        },
        status: "already_resolved_different",
        message: /existing sha256:a{64}/,
      },
      {
        failure: { status: 409, currentState: "binding_mismatch" },
        status: "binding_mismatch",
      },
      { failure: { status: 410 }, status: "unknown_interaction" },
      { failure: { status: 404 }, status: "unknown_interaction" },
      { failure: { status: 400 }, status: "invalid_response" },
      { failure: { status: 503 }, status: "transport_failure" },
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
