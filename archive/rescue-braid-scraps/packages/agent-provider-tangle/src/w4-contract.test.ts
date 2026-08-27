import { describe, expect, it } from "vitest";
import {
  AgentNativeContextContinuationResultSchema,
  canonicalAgentProfileDigest,
  contextTransferRequestDigest,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
  portableConversationContextDigest,
  portableContextPlanDigest,
  workspaceCheckpointRequestDigest,
  workspaceForkRequestDigest,
  type AgentEnvironmentCapabilities,
  type AgentRunControlRef,
  type ContextTransferRequest,
  type InteractionAcknowledgement,
  type InteractionRequest,
  type InteractionResponseCommand,
  type NativeContextContinuationRequest,
  type PortableConversationContext,
  type PortableContextPlan,
  type WorkspaceCheckpointRef,
  type WorkspaceForkRequest,
  type WorkspaceOperationLookupRequest,
} from "@tangle-network/agent-interface";
import {
  runInteractionResponseConformance,
  runSessionReplayConformance,
} from "@tangle-network/agent-provider-testkit";
import type { PromptResult, SandboxEvent } from "@tangle-network/sandbox";
import {
  createTangleProvider,
  defaultTangleSandboxCapabilities,
  type SandboxClientLike,
  type SandboxInstanceLike,
  type SandboxSessionLike,
} from "./index.js";

const providerName = "tangle-sandbox";
const environmentId = "sbx-w4";
const sessionId = "session-w4";
const executionId = "execution-w4";

function capabilities(): AgentEnvironmentCapabilities {
  const base = defaultTangleSandboxCapabilities();
  return {
    ...base,
    placement: true,
    confidential: true,
    interactions: {
      kinds: ["question"],
      answerFieldTypes: ["text"],
      responseScopes: ["interaction"],
      secretAnswers: false,
      concurrentRequests: true,
      replay: true,
      responseIdempotency: true,
    },
    nativeContinuation: {
      atomicBoundary: true,
      requestIdempotency: true,
    },
    branching: {
      checkpoint: true,
      fork: true,
      retrySafe: true,
      lookup: true,
      cleanup: true,
    },
  };
}

function controlRef(): AgentRunControlRef {
  return {
    runId: executionId,
    provider: providerName,
    environmentId,
    sessionId,
    executionId,
  };
}

function interactionCommand(operationId = "interaction-operation"): InteractionResponseCommand {
  return {
    operationId,
    binding: {
      runId: executionId,
      environmentId,
      sessionId,
      interactionId: "interaction-1",
    },
    response: {
      id: "interaction-1",
      outcome: "accepted",
      data: { answer: "yes" },
    },
  };
}

function profileReceipt(caps: AgentEnvironmentCapabilities) {
  return {
    ok: true,
    issues: [],
    effectiveCapabilities: {
      "session.eventsReplay": true,
      "session.exactExecutionCancel": true,
    },
    capabilities: caps,
    placement: {
      environmentId,
      requested: true,
      verified: false as const,
      reason: "placement quote validation is not available in the adapter",
    },
    session: {
      eventsReplay: true,
      terminalResult: true,
      exactExecutionCancel: true,
      interactions: true,
    },
    usage: { tokenUsage: true, cost: true },
    materialization: {
      profileDigest: "a".repeat(64),
      receiptId: "profile-receipt-1",
      resourceCounts: { tools: 1 },
      secretsMaterialized: false as const,
    },
    confidentiality: {
      requested: true,
      verified: false as const,
      evidence: null,
    },
  };
}

function portableTransferRequest(): ContextTransferRequest {
  const sourceMaterial = {
    source: {
      runId: "source-run",
      provider: "source-provider",
      environmentId: "source-environment",
      sessionId: "source-session",
    },
    completeness: "complete" as const,
    messages: [
      {
        id: "message-1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Continue." }],
        timestamp: "2026-08-01T20:00:00.000Z",
      },
    ],
    attachments: [],
  };
  const source: PortableConversationContext = {
    ...sourceMaterial,
    digest: portableConversationContextDigest(sourceMaterial),
  };
  const contextMaterial = {
    source: source.source,
    completeness: "complete" as const,
    messages: source.messages,
    attachments: [],
  };
  const context = {
    ...contextMaterial,
    digest: portableConversationContextDigest(contextMaterial),
  };
  const planMaterial = {
    planId: "plan-1",
    source,
    destination: { runner: "codex", provider: providerName },
    messages: [
      {
        messageId: "message-1",
        action: "include" as const,
        parts: [{ partIndex: 0, action: "include" as const }],
      },
    ],
    context,
    estimatedTokens: 2,
    requiresAcceptance: false,
  };
  const plan: PortableContextPlan = {
    ...planMaterial,
    digest: portableContextPlanDigest(planMaterial),
  };
  const acceptance = {
    planDigest: plan.digest,
    acceptedAt: "2026-08-01T20:01:00.000Z",
    acceptedBy: "system" as const,
  };
  const material = { plan, acceptance };
  return {
    operationId: "transfer-operation",
    requestDigest: contextTransferRequestDigest(material),
    ...material,
  } as ContextTransferRequest;
}

function nativeContinuationRequest(): NativeContextContinuationRequest {
  const boundary = {
    runId: executionId,
    provider: providerName,
    environmentId,
    sessionId,
    boundary: { kind: "token" as const, token: "boundary-1" },
    observedAt: "2026-08-01T20:01:00.000Z",
  };
  const turn = { prompt: "Continue natively." };
  const material = {
    turnDigest: nativeContextContinuationTurnDigest(turn),
    run: controlRef(),
    expectedBoundary: boundary,
  };
  return {
    operationId: "native-operation",
    requestDigest: nativeContextContinuationRequestDigest(material),
    ...material,
  };
}

function workspaceBranching() {
  const checkpoints = new Map<string, WorkspaceCheckpointRef>();
  const forks = new Map<string, {
    environmentId: string;
    provider: string;
    sourceCheckpointId: string;
    idempotencyKey: string;
    requestDigest: `sha256:${string}`;
    createdAt: string;
    confidential: boolean;
    metadata?: Record<string, unknown>;
  }>();
  return {
    async checkpoint(request: any) {
      const existing = checkpoints.get(request.idempotencyKey);
      if (existing && existing.requestDigest !== request.requestDigest) {
        return {
          status: "conflict" as const,
          idempotencyKey: request.idempotencyKey,
          requestDigest: request.requestDigest,
          existingRequestDigest: existing.requestDigest,
        };
      }
      if (existing) {
        return {
          status: "replayed" as const,
          idempotencyKey: request.idempotencyKey,
          requestDigest: request.requestDigest,
          checkpoint: existing,
        };
      }
      const checkpoint: WorkspaceCheckpointRef = {
        checkpointId: "checkpoint-1",
        provider: providerName,
        source: request.source,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        createdAt: "2026-08-01T20:02:00.000Z",
        metadata: request.metadata,
      };
      checkpoints.set(request.idempotencyKey, checkpoint);
      return {
        status: "created" as const,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        checkpoint,
      };
    },
    async lookupCheckpoint(request: WorkspaceOperationLookupRequest) {
      const checkpoint = checkpoints.get(request.idempotencyKey);
      return checkpoint
        ? { status: "found" as const, ...request, checkpoint }
        : { status: "not_found" as const, ...request };
    },
    async deleteCheckpoint(request: any) {
      checkpoints.delete(request.targetId);
      return {
        operationId: request.operationId,
        targetId: request.targetId,
        provider: providerName,
        status: "deleted" as const,
      };
    },
    async fork(request: any) {
      const environment = {
        environmentId: "forked-environment",
        provider: providerName,
        sourceCheckpointId: request.checkpoint.checkpointId,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        createdAt: "2026-08-01T20:03:00.000Z",
        confidential: false,
        metadata: request.metadata,
      };
      forks.set(request.idempotencyKey, environment);
      return {
        status: "created" as const,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        environment,
      };
    },
    async lookupFork(request: WorkspaceOperationLookupRequest) {
      const environment = forks.get(request.idempotencyKey);
      return environment
        ? {
            status: "found" as const,
            idempotencyKey: request.idempotencyKey,
            requestDigest: request.requestDigest,
            environment,
          }
        : {
            status: "not_found" as const,
            idempotencyKey: request.idempotencyKey,
            requestDigest: request.requestDigest,
          };
    },
    async destroyFork(request: any) {
      forks.delete(request.targetId);
      return {
        operationId: request.operationId,
        targetId: request.targetId,
        provider: providerName,
        status: "already_absent" as const,
      };
    },
  };
}

describe("Tangle Braid W4 contracts", () => {
  it("keeps deterministic HTTP dispatch and interaction wire identities", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const baseUrl = "https://deterministic.test";
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const path = new URL(url).pathname;
      requests.push({ method, path, body });
      let responseBody: unknown;
      if (method === "POST" && path === "/v1/sandboxes") {
        responseBody = { id: environmentId };
      } else if (method === "POST" && path === "/v1/sandboxes/sbx-w4/dispatch") {
        responseBody = { sessionId, executionId, status: "running" };
      } else if (method === "GET" && path === `/v1/sandboxes/${environmentId}/sessions/${sessionId}/interactions`) {
        responseBody = {
          interactions: [{
            id: "interaction-1",
            kind: "question",
            title: "Continue?",
            answerSpec: {
              fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
            },
          }],
          bindings: {
            "interaction-1": {
              runId: executionId,
              environmentId,
              sessionId,
              interactionId: "interaction-1",
              executionId,
            },
          },
          resolved: [],
        };
      } else if (method === "POST" && path === `/v1/sandboxes/${environmentId}/sessions/${sessionId}/interactions`) {
        responseBody = {
          operationId: body.operationId,
          binding: body.binding,
          status: "accepted",
          requestDigest: body.requestDigest,
          acknowledgedAt: "2026-08-01T20:05:00.000Z",
        };
      } else {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const session: SandboxSessionLike = {
      id: sessionId,
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async () => ({ success: true, status: "success", executionId, durationMs: 1 }),
      prompt: async () => ({ success: true, status: "success", executionId, durationMs: 1 }),
      interactions: async () => (await (await fetch(`${baseUrl}/v1/sandboxes/${environmentId}/sessions/${sessionId}/interactions`)).json()),
      respondToInteraction: async (command) => (await (await fetch(`${baseUrl}/v1/sandboxes/${environmentId}/sessions/${sessionId}/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      })).json()),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = {
      id: environmentId,
      async *streamPrompt() {},
      dispatchPrompt: async (message, options) => (await (await fetch(`${baseUrl}/v1/sandboxes/${environmentId}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, options }),
      })).json()),
      session: () => session,
    };
    const client: SandboxClientLike = {
      create: async (options) => {
        const response = await fetch(`${baseUrl}/v1/sandboxes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options),
        });
        const data = (await response.json()) as { id: string };
        return { ...box, id: data.id };
      },
    };
    try {
      const provider = createTangleProvider({
        client,
        capabilities: { ...defaultTangleSandboxCapabilities(), interactions: capabilities().interactions },
      });
      const environment = await provider.create({ profile: { name: "http-contract" } });
      const reference = await environment.dispatch!({ prompt: "hello", turnId: "turn-http" });
      expect(reference.controlRef?.executionId).toBe(executionId);
      const acknowledgement = await environment.respondToInteraction!(interactionCommand());
      expect(acknowledgement.status).toBe("accepted");
      const dispatchWire = requests.find((request) => request.path.endsWith("/dispatch"));
      expect(dispatchWire).toMatchObject({ method: "POST", body: { message: "hello", options: { turnId: "turn-http" } } });
      const responseWire = requests.find((request) => request.method === "POST" && request.path.endsWith("/interactions"));
      expect(responseWire?.body).toMatchObject({
        operationId: "interaction-operation",
        binding: { runId: executionId, environmentId, sessionId, interactionId: "interaction-1", executionId },
      });
      expect((responseWire?.body as Record<string, unknown>).requestDigest).toMatch(/^sha256:/);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("keeps exact run identity through restart, replay, cancellation, and testkit conformance", async () => {
    const events: SandboxEvent[] = [
      {
        id: "event-1",
        type: "status",
        data: { executionId, sessionId, status: "processing" },
      },
      {
        id: "event-2",
        type: "result",
        data: {
          executionId,
          sessionId,
          finalText: "ok",
          usage: { inputTokens: 1, outputTokens: 2 },
        },
      },
    ];
    const dispatches = new Map<string, string>();
    const interruptCalls: string[] = [];
    const box: SandboxInstanceLike = {
      id: environmentId,
      async *streamPrompt(): AsyncIterable<SandboxEvent> {
        yield* events;
      },
      dispatchPrompt: async (_message, options) => {
        const turnId = options?.turnId ?? "default-turn";
        const id = dispatches.get(turnId) ?? executionId;
        dispatches.set(turnId, id);
        return { sessionId, executionId: id, status: "running", alreadyExisted: dispatches.has(turnId) };
      },
      session: (id) => ({
        id,
        status: async () => ({ status: "completed", latestExecutionId: executionId }),
        async *events(options) {
          for (const event of events) {
            if (options?.executionId && event.data.executionId !== options.executionId) {
              yield { ...event, data: { ...event.data, executionId } };
            } else {
              yield event;
            }
          }
        },
        result: async (options) => ({
          success: true,
          status: "success",
          executionId: options?.executionId,
          response: "ok",
          durationMs: 1,
        }),
        prompt: async (_message, options) => ({
          success: true,
          status: "success",
          executionId: options?.executionId ?? executionId,
          response: "ok",
          durationMs: 1,
        }),
        interrupt: async (options) => {
          if (!options?.executionId) throw new Error("missing exact execution id");
          interruptCalls.push(options.executionId);
          return { cancelled: true, outcome: "cancelled" };
        },
      }),
      delete: async () => undefined,
    };
    const client: SandboxClientLike = {
      create: async () => box,
      get: async (id) => (id === environmentId ? box : null),
    };
    const provider = createTangleProvider({ client });
    const report = await runSessionReplayConformance({
      name: "w4",
      createProvider: () => provider,
      turn: { prompt: "hello", turnId: "turn-1" },
      reconnect: async (reference) => {
        const environment = await provider.create({ profile: { name: "reconnected" } });
        return environment.session!(reference.id, { controlRef: reference.controlRef });
      },
    });
    expect(report.checked).toContain("reconnected-replay");
    const environment = await provider.create({ profile: { name: "worker" } });
    const first = await environment.dispatch!({ prompt: "same", turnId: "stable" });
    const second = await environment.dispatch!({ prompt: "same", turnId: "stable" });
    expect(second.controlRef).toEqual(first.controlRef);
    const exact = environment.session!(sessionId, { controlRef: first.controlRef });
    await exact.cancel();
    expect(interruptCalls).toContain(executionId);
    await expect(environment.session!(sessionId).result()).rejects.toThrow(/exact executionId/);
  });

  it("returns canonical interaction, context, native, workspace, and evidence receipts", async () => {
    const caps = capabilities();
    const request = portableTransferRequest();
    const nativeRequest = nativeContinuationRequest();
    const checkpointSource = controlRef();
    const checkpointMaterial = { source: checkpointSource, name: "before" };
    const checkpointRequest = {
      ...checkpointMaterial,
      idempotencyKey: "checkpoint-operation",
      requestDigest: workspaceCheckpointRequestDigest(checkpointMaterial),
    };
    const interactionOperations = new Map<
      string,
      { digest: string; acknowledgement: InteractionAcknowledgement }
    >();
    let resolvedInteractionDigest: string | undefined;
    const box: SandboxInstanceLike = {
      id: environmentId,
      name: "w4",
      async *streamPrompt() {},
      validateProfile: async () => profileReceipt(caps),
      resourceUsage: async () => ({ memoryMb: 4 }),
      teeAttestation: async (options) => ({ options, verification: { placementVerified: false } }),
      transferContext: async () => ({
        status: "accepted",
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        planDigest: request.plan.digest,
        contextDigest: request.plan.context.digest,
        destination: request.plan.destination,
        provider: providerName,
        environmentId,
        sessionId: "session-transferred",
        sessionCreatedForOperationId: request.operationId,
        sessionCreatedAt: "2026-08-01T20:01:01.000Z",
        transferredMessageIds: ["message-1"],
        omittedMessageIds: [],
        admittedAt: "2026-08-01T20:01:02.000Z",
      }),
      workspaceBranching: workspaceBranching(),
      session: () => ({
        id: sessionId,
        status: async () => ({ status: "running" }),
        async *events() {},
        result: async () => ({ success: true, status: "success", executionId, durationMs: 1 }),
        prompt: async () => ({ success: true, status: "success", executionId, durationMs: 1 }),
        interactions: async () => ({
          interactions: [
            {
              id: "interaction-1",
              kind: "question",
              title: "Continue?",
              answerSpec: {
                fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
              },
            },
          ],
          bindings: {
            "interaction-1": {
              runId: executionId,
              environmentId,
              sessionId,
              interactionId: "interaction-1",
              executionId,
            },
          },
          resolved: [],
        }),
        respondToInteraction: async (command: any) => {
          const digest = JSON.stringify({ binding: command.binding, response: command.response });
          const acknowledgement = (
            status: InteractionAcknowledgement["status"],
            message?: string,
            retryable?: boolean,
          ) => ({
            operationId: command.operationId,
            binding: command.binding,
            requestDigest: command.requestDigest,
            status,
            ...(message ? { message } : {}),
            ...(retryable !== undefined ? { retryable } : {}),
            acknowledgedAt: "2026-08-01T20:04:00.000Z",
          });
          if (command.operationId.endsWith("-expired")) return acknowledgement("expired");
          if (command.operationId.endsWith("-cancelled")) return acknowledgement("cancelled");
          if (command.operationId.endsWith("-transport-failure")) {
            return acknowledgement("transport_failure", "test transport is unavailable", true);
          }
          const prior = interactionOperations.get(command.operationId);
          if (prior) {
            return prior.digest === digest
              ? prior.acknowledgement
              : acknowledgement("already_resolved_different");
          }
          if (command.response.data?.["testkit-undeclared-field"] !== undefined) {
            return acknowledgement("invalid_response", "undeclared response field");
          }
          const result = resolvedInteractionDigest
            ? acknowledgement(
                resolvedInteractionDigest === digest
                  ? "already_resolved_same"
                  : "already_resolved_different",
              )
            : acknowledgement("accepted");
          if (!resolvedInteractionDigest) resolvedInteractionDigest = digest;
          interactionOperations.set(command.operationId, { digest, acknowledgement: result });
          return result;
        },
        contextBoundary: async () => ({
          runId: executionId,
          provider: providerName,
          environmentId,
          sessionId,
          boundary: { kind: "token", token: "boundary-1" },
          observedAt: "2026-08-01T20:01:00.000Z",
        }),
        continueNative: async (continuationRequest) => ({
          acknowledgement: {
            operationId: continuationRequest.operationId,
            requestDigest: continuationRequest.requestDigest,
            status: "accepted",
            historyMessagesSent: 0,
            actualBoundary: continuationRequest.expectedBoundary,
          },
          result: { text: "continued", success: true, sessionId },
          controlRef: controlRef(),
        }),
        interrupt: async () => ({ cancelled: true }),
      }),
    };
    const client: SandboxClientLike = {
      create: async () => box,
      describePlacement: () => ({ kind: "sandbox", sandboxId: environmentId, region: "us-test-1" }),
    };
    const provider = createTangleProvider({ client, capabilities: caps });
    const environment = await provider.create({ profile: { name: "worker" } });

    const interactionRequest: InteractionRequest = {
      id: "interaction-1",
      kind: "question",
      title: "Continue?",
      answerSpec: {
        fields: [{ type: "text", name: "answer", label: "Answer", required: true }],
      },
      responseScopes: ["interaction"],
    };
    const interactionReport = await runInteractionResponseConformance({
      name: "w4-interactions",
      request: interactionRequest,
      command: interactionCommand(),
      statusCases: (["expired", "cancelled", "transport_failure"] as const).map((status) => ({
        request: interactionRequest,
        command: {
          ...interactionCommand(),
          operationId: `interaction-operation-${status.replaceAll("_", "-")}`,
        },
        expectedStatus: status,
      })),
      respond: (command) => environment.respondToInteraction!(command),
    });
    expect(interactionReport.checked).toContain("different-response-conflict");

    expect(environment.profileReceipt?.capabilities).toEqual(caps);
    expect(Object.isFrozen(environment.profileReceipt)).toBe(true);
    expect(environment.profileDigest).toBe(canonicalAgentProfileDigest({ name: "worker" }));
    await expect(environment.placement!()).resolves.toEqual({
      kind: "sandbox",
      sandboxId: environmentId,
      region: "us-test-1",
    });
    await expect(environment.transferContext!(request)).resolves.toMatchObject({
      status: "accepted",
      sessionId: "session-transferred",
    });
    const command = interactionCommand();
    await expect(environment.respondToInteraction!(command)).resolves.toMatchObject({
      operationId: command.operationId,
      status: "accepted",
      binding: command.binding,
    });
    const session = environment.session!(sessionId, { controlRef: controlRef() });
    const boundary = await session.contextBoundary!();
    expect(boundary?.runId).toBe(executionId);
    const native = await session.continueNative!(nativeRequest, { turn: { prompt: "Continue natively." } });
    expect(AgentNativeContextContinuationResultSchema.parse(native).acknowledgement.status).toBe("accepted");

    const checkpoint = await environment.workspaceBranching!.checkpoint(checkpointRequest);
    expect(checkpoint.status).toBe("created");
    await expect(
      environment.workspaceBranching!.lookupCheckpoint({
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
      }),
    ).resolves.toMatchObject({ status: "found", checkpoint: { checkpointId: "checkpoint-1" } });
    const checkpointRef = checkpoint.status === "created" ? checkpoint.checkpoint : checkpoint.status === "replayed" ? checkpoint.checkpoint : undefined;
    expect(checkpointRef).toBeDefined();
    const forkMaterial = { checkpoint: checkpointRef!, name: "fork" };
    const forkRequest: WorkspaceForkRequest = {
      ...forkMaterial,
      idempotencyKey: "fork-operation",
      requestDigest: workspaceForkRequestDigest(forkMaterial),
    };
    const fork = await environment.workspaceBranching!.fork(forkRequest);
    expect(fork.status).toBe("created");
    if (fork.status === "created" || fork.status === "replayed") {
      await expect(
        environment.workspaceBranching!.destroyFork({
          operationId: "fork-cleanup",
          targetId: fork.environment.environmentId,
          provider: providerName,
        }),
      ).resolves.toMatchObject({ status: "already_absent", targetId: "forked-environment" });
    }
    await expect(
      environment.workspaceBranching!.deleteCheckpoint({
        operationId: "checkpoint-cleanup",
        targetId: "checkpoint-1",
        provider: providerName,
      }),
    ).resolves.toMatchObject({ status: "deleted", targetId: "checkpoint-1" });
    await expect(environment.evidence!()).resolves.toMatchObject({
      profile: { materialization: { secretsMaterialized: false } },
      placement: { sandboxId: environmentId },
      usage: { memoryMb: 4 },
      confidentiality: { verified: false, evidence: null },
    });
    await expect(environment.attestation!({ nonce: "n-1" })).resolves.toMatchObject({
      verification: { placementVerified: false },
    });
  });

  it("rejects missing runtime IDs and incomplete usage before claiming a run", async () => {
    let promptCalls = 0;
    const session: SandboxSessionLike = {
      id: sessionId,
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async () => ({ success: true, status: "success", durationMs: 1 }),
      prompt: async () => {
        promptCalls += 1;
        return { success: true, status: "success", durationMs: 1 } as PromptResult;
      },
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = {
      id: "sbx-fail-closed",
      async *streamPrompt() {
        yield { id: "event-1", type: "result", data: { usage: { inputTokens: 1 } } } as SandboxEvent;
      },
      session: () => session,
    };
    const provider = createTangleProvider({ client: { create: async () => box } });
    const environment = await provider.create({ profile: { name: "worker" } });
    await expect(environment.session!(sessionId).prompt({ prompt: "no id" })).rejects.toThrow(/no exact executionId/);
    expect(promptCalls).toBe(1);
    await expect((async () => {
      for await (const _event of environment.stream({ prompt: "bad usage" })) {
        // Consume the stream to force validation.
      }
    })()).rejects.toThrow(/usage is incomplete/);
  });
});
