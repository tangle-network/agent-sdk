import { describe, expect, it } from "vitest";
import {
  InteractionKind,
  interactionRequestDigest,
  interactionResponseCommandDigest,
  permissionAnswerSpec,
} from "@tangle-network/agent-interface";
import type {
  InteractionData,
  InteractionField,
  InteractionRequest,
  InteractionResponse,
  InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { createTangleProvider } from "./index.js";
import type {
  SandboxInstanceLike,
  SandboxInteractionCommandResultLike,
  SandboxRuntimeCapabilityDocument,
  SandboxSessionLike,
} from "./tangle-types.js";
import { RETAINED_DEPLOYMENT_DOCUMENT } from "./retained-control-test-helpers.js";

const PROVIDER = "tangle-sandbox";
const ENVIRONMENT_ID = "sbx-interactions";
const SESSION_ID = "session-interactions";
const RUN_ID = "run-interactions";
const EXECUTION_ID = "execution-interactions";

/** A deployment that records what it acknowledges. */
const RESPONSE_RECORDING_DOCUMENT: SandboxRuntimeCapabilityDocument = {
  ...RETAINED_DEPLOYMENT_DOCUMENT,
  interactions: { responseDedupe: true },
};

function interactionRequest(options: {
  id: string;
  kind: string;
  fields: InteractionField[];
  responseScopes?: readonly ("interaction" | "session" | "persistent")[];
  binding?: { environmentId?: string; sessionId?: string; provider?: string };
}): InteractionRequest {
  const material = {
    id: options.id,
    kind: options.kind,
    title: `ask ${options.id}`,
    answerSpec: { fields: options.fields },
    ...(options.responseScopes
      ? { responseScopes: [...options.responseScopes] }
      : {}),
    binding: {
      runId: RUN_ID,
      provider: options.binding?.provider ?? PROVIDER,
      environmentId: options.binding?.environmentId ?? ENVIRONMENT_ID,
      sessionId: options.binding?.sessionId ?? SESSION_ID,
      executionId: EXECUTION_ID,
      interactionId: options.id,
    },
  } satisfies Omit<InteractionRequest, "requestDigest">;
  return { ...material, requestDigest: interactionRequestDigest(material) };
}

function responseCommand(
  request: InteractionRequest,
  response: InteractionResponse,
  operationId = `op-${request.id}`,
): InteractionResponseCommand {
  const binding = { ...request.binding, requestDigest: request.requestDigest };
  return {
    operationId,
    binding,
    commandDigest: interactionResponseCommandDigest({ binding, response }),
    response,
  };
}

interface Harness {
  environment: AgentEnvironment;
  commands: InteractionResponseCommand[];
}

/**
 * One sandbox whose session records every command it is sent and replies with
 * the result the test names. The provider's own surface is the entry point,
 * so the capability document and the exposed method are read as a caller sees
 * them.
 */
async function harness(options: {
  outstanding?: readonly InteractionRequest[];
  document?: SandboxRuntimeCapabilityDocument | null;
  result?: (
    command: InteractionResponseCommand,
  ) => SandboxInteractionCommandResultLike;
  listFails?: boolean;
}): Promise<Harness> {
  const commands: InteractionResponseCommand[] = [];
  const session = (id: string): SandboxSessionLike => ({
    id,
    status: async () => ({ status: "running" }),
    async *events() {},
    result: async () => ({ success: true, status: "success", durationMs: 1 }),
    prompt: async () => ({ success: true, status: "success", durationMs: 1 }),
    interrupt: async () => ({ cancelled: true }),
    cancelRun: async (request) => ({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      run: request.run,
      status: "accepted",
      effect: "not_live",
    }),
    interactions: async () => {
      if (options.listFails) throw new Error("outstanding set unreadable");
      return options.outstanding ?? [];
    },
    respondToInteraction: async (command) => {
      commands.push(command);
      return (
        options.result?.(command) ?? {
          acknowledgement: {
            operationId: command.operationId,
            binding: command.binding,
            commandDigest: command.commandDigest,
            status: "accepted",
          },
          serverResult: { status: "accepted", delivered: true },
        }
      );
    },
  });
  const box: SandboxInstanceLike = {
    id: ENVIRONMENT_ID,
    status: "running",
    async *streamPrompt() {},
    dispatchPrompt: async () => ({
      sessionId: SESSION_ID,
      status: "running",
      alreadyExisted: false,
      dispatched: true,
    }),
    session,
    capabilities: async () =>
      options.document === undefined
        ? RESPONSE_RECORDING_DOCUMENT
        : options.document,
    delete: async () => undefined,
  };
  const provider = createTangleProvider({
    client: {
      create: async () => box,
      get: async (id) => (id === box.id ? box : null),
    },
  });
  const environment = await provider.create({ profile: { name: "worker" } });
  return { environment, commands };
}

describe("Tangle interaction responses", () => {
  it("carries every interaction kind to the command route under its own id", async () => {
    // The canonical command names the ask it answers, so one route resolves
    // all three kinds. What must survive is the id and the caller's own
    // answer, unchanged.
    const cases: Array<{
      kind: string;
      fields: InteractionField[];
      data: InteractionData | undefined;
      scopes: readonly ("interaction" | "session" | "persistent")[] | undefined;
    }> = [
      {
        kind: InteractionKind.Question,
        fields: [
          { name: "branch", label: "Branch", type: "text", required: true },
        ] satisfies InteractionField[],
        data: { branch: "main" },
        scopes: undefined,
      },
      {
        kind: InteractionKind.Permission,
        fields: permissionAnswerSpec({ responseScopes: ["interaction"] })
          .fields as InteractionField[],
        data: { grant: ["allow_once"] },
        scopes: ["interaction"] as const,
      },
      {
        kind: InteractionKind.Plan,
        fields: [] satisfies InteractionField[],
        data: undefined,
        scopes: undefined,
      },
    ];

    for (const testCase of cases) {
      const request = interactionRequest({
        id: `ask-${testCase.kind}`,
        kind: testCase.kind,
        fields: testCase.fields,
        ...(testCase.scopes ? { responseScopes: testCase.scopes } : {}),
      });
      const command = responseCommand(request, {
        id: request.id,
        outcome: "accepted",
        ...(testCase.data ? { data: testCase.data } : {}),
      });
      const { environment, commands } = await harness({
        outstanding: [request],
      });

      const acknowledgement = await environment.respondToInteraction!(command);

      expect(commands).toHaveLength(1);
      expect(commands[0]!.binding.interactionId).toBe(request.id);
      expect(commands[0]!.response).toEqual(command.response);
      expect(commands[0]!.operationId).toBe(command.operationId);
      expect(acknowledgement.status).toBe("accepted");
      expect(acknowledgement.commandDigest).toBe(command.commandDigest);
    }
  });

  it("answers through a session handle as well as the environment", async () => {
    const request = interactionRequest({
      id: "ask-session",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment, commands } = await harness({ outstanding: [request] });

    const session = environment.session!(SESSION_ID);
    const acknowledgement = await session.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("accepted");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.binding.interactionId).toBe(request.id);
  });

  it("reports the deployment's replay as already resolved with the same answer", async () => {
    const request = interactionRequest({
      id: "ask-replay",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment } = await harness({
      outstanding: [request],
      result: (sent) => ({
        acknowledgement: {
          operationId: sent.operationId,
          binding: sent.binding,
          commandDigest: sent.commandDigest,
          status: "already_resolved_same",
        },
        serverResult: {
          status: "already_resolved_same",
          delivered: true,
        },
      }),
    });

    const acknowledgement = await environment.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("already_resolved_same");
  });

  it("reports a conflicting answer as already resolved differently and names the recorded digest", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const request = interactionRequest({
      id: "ask-conflict",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "other" },
    });
    const { environment } = await harness({
      outstanding: [request],
      result: (sent) => ({
        acknowledgement: {
          operationId: sent.operationId,
          binding: sent.binding,
          commandDigest: sent.commandDigest,
          status: "already_resolved_different",
          message: "interaction already holds another response",
        },
        serverResult: {
          status: "already_resolved_different",
          message: "interaction already holds another response",
          existingResponseDigest: digest,
        },
      }),
    });

    const acknowledgement = await environment.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("already_resolved_different");
    expect(acknowledgement.message).toContain(digest);
  });

  it("reports an ask the deployment does not know as unknown", async () => {
    const request = interactionRequest({
      id: "ask-unknown",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment } = await harness({
      outstanding: [],
      result: (sent) => ({
        acknowledgement: {
          operationId: sent.operationId,
          binding: sent.binding,
          commandDigest: sent.commandDigest,
          status: "unknown_interaction",
          message: "no such interaction",
        },
      }),
    });

    const acknowledgement = await environment.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("unknown_interaction");
  });

  it("refuses an answer that omits a required field, naming it, and delivers nothing", async () => {
    // The refusal names the field instead of substituting a value for it. An
    // invented default would reach the waiting agent as a real answer.
    const request = interactionRequest({
      id: "ask-incomplete",
      kind: InteractionKind.Question,
      fields: [
        { name: "branch", label: "Branch", type: "text", required: true },
        { name: "force", label: "Force", type: "boolean", required: true },
      ],
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment, commands } = await harness({ outstanding: [request] });

    const acknowledgement = await environment.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("invalid_response");
    expect(acknowledgement.message).toContain('missing required field "force"');
    expect(commands).toEqual([]);
  });

  it("refuses a command bound to another environment and delivers nothing", async () => {
    const request = interactionRequest({
      id: "ask-foreign-environment",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
      binding: { environmentId: "sbx-elsewhere" },
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment, commands } = await harness({ outstanding: [] });

    const acknowledgement = await environment.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("binding_mismatch");
    expect(commands).toEqual([]);
  });

  it("refuses a command aimed at another session of the same sandbox", async () => {
    // A session handle answers its own asks only. Delivering here would put
    // one session's answer on another session's ask.
    const request = interactionRequest({
      id: "ask-foreign-session",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
      binding: { sessionId: "session-elsewhere" },
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment, commands } = await harness({ outstanding: [] });

    const session = environment.session!(SESSION_ID);
    const acknowledgement = await session.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("binding_mismatch");
    expect(commands).toEqual([]);
  });

  it("never reports an unconfirmed delivery as accepted", async () => {
    const request = interactionRequest({
      id: "ask-undelivered",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment } = await harness({
      outstanding: [request],
      result: (sent) => ({
        acknowledgement: {
          operationId: sent.operationId,
          binding: sent.binding,
          commandDigest: sent.commandDigest,
          status: "accepted",
        },
        serverResult: { status: "accepted", delivered: false },
      }),
    });

    const acknowledgement = await environment.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("transport_failure");
    expect(acknowledgement.retryable).toBe(true);
  });

  it("refuses an acknowledgement issued for another operation", async () => {
    const request = interactionRequest({
      id: "ask-mismatched",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment } = await harness({
      outstanding: [request],
      result: (sent) => ({
        acknowledgement: {
          operationId: "op-somebody-else",
          binding: sent.binding,
          commandDigest: sent.commandDigest,
          status: "accepted",
        },
      }),
    });

    await expect(environment.respondToInteraction!(command)).rejects.toThrow(
      /acknowledgement for another operation/,
    );
  });

  it("delivers the answer when the outstanding set cannot be read", async () => {
    // The spec read is for the message it produces, not a gate. The command
    // carries only what the caller supplied, and the deployment validates it.
    const request = interactionRequest({
      id: "ask-unreadable",
      kind: InteractionKind.Question,
      fields: [{ name: "branch", label: "Branch", type: "text" }],
    });
    const command = responseCommand(request, {
      id: request.id,
      outcome: "accepted",
      data: { branch: "main" },
    });
    const { environment, commands } = await harness({ listFails: true });

    const acknowledgement = await environment.respondToInteraction!(command);

    expect(acknowledgement.status).toBe("accepted");
    expect(commands).toHaveLength(1);
  });
});

describe("Tangle interaction capability gating", () => {
  it("claims interactions only when the deployment reports the response record", async () => {
    const { environment } = await harness({});

    expect(environment.capabilities?.interactions).toBeDefined();
    expect(environment.capabilities?.interactions?.responseIdempotency).toBe(
      true,
    );
    expect(typeof environment.respondToInteraction).toBe("function");
  });

  it("withholds the capability and the method when the flag is absent", async () => {
    const { environment } = await harness({
      document: RETAINED_DEPLOYMENT_DOCUMENT,
    });

    expect(environment.capabilities?.interactions).toBeUndefined();
    expect(environment.respondToInteraction).toBeUndefined();
    expect(environment.session!(SESSION_ID).respondToInteraction).toBeUndefined();
  });

  it("withholds the capability when the deployment reports it false", async () => {
    const { environment } = await harness({
      document: {
        ...RETAINED_DEPLOYMENT_DOCUMENT,
        interactions: { responseDedupe: false },
      },
    });

    expect(environment.capabilities?.interactions).toBeUndefined();
    expect(environment.respondToInteraction).toBeUndefined();
  });

  it("withholds the capability when the document is null", async () => {
    const { environment } = await harness({ document: null });

    expect(environment.capabilities?.interactions).toBeUndefined();
    expect(environment.respondToInteraction).toBeUndefined();
  });
});
