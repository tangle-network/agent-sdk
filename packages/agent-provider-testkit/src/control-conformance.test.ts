import { describe, expect, it } from "vitest";
import {
  nativeContextContinuationTurnDigest,
  portableContextPlanDigest,
  portableContextPlanRequestDigest,
  portableConversationContextDigest,
  interactionRequestDigest,
  interactionResponseCommandDigest,
  validateInteractionResponse,
  workspaceCheckpointRequestDigest,
  workspaceForkRequestDigest,
  type AgentEnvironmentProvider,
  type AgentNativeContextContinuationOptions,
  type AgentNativeContextContinuationResult,
  type AgentWorkspaceBranching,
  type ContextTransferReceipt,
  type ContextTransferRequest,
  type InteractionAcknowledgement,
  type InteractionRequest,
  type InteractionResponseCommand,
  type InteractionRequestMaterial,
  type NativeContextBoundaryProof,
  type NativeContextContinuationRequest,
  type PortableContextPlan,
  type PortableContextPlanRequest,
  type PortableConversationContext,
  type WorkspaceCheckpointRef,
  type WorkspaceForkRequest,
} from "@tangle-network/agent-interface";
import {
  runAgentEnvironmentProviderConformance,
  runInteractionResponseConformance,
  runPortableContextConformance,
  runSessionReplayConformance,
  runWorkspaceBranchingConformance,
} from "./index.js";

describe("runInteractionResponseConformance", () => {
  it("proves wrong bindings, operation replay, and response conflicts", async () => {
    const interactionRequestMaterial: InteractionRequestMaterial = {
      id: "interaction-1",
      kind: "question",
      title: "Continue?",
      answerSpec: {
        fields: [
          {
            type: "text",
            name: "answer",
            label: "Answer",
            required: true,
          },
        ],
      },
      responseScopes: ["interaction"],
      binding: {
        runId: "run-1",
        provider: "test-provider",
        environmentId: "environment-1",
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-1",
      },
    };
    const request: InteractionRequest = {
      ...interactionRequestMaterial,
      requestDigest: interactionRequestDigest(interactionRequestMaterial),
    };
    const commandMaterial = {
      operationId: "respond-1",
      binding: {
        ...request.binding,
        requestDigest: request.requestDigest,
      },
      response: {
        id: "interaction-1",
        outcome: "accepted" as const,
        data: { answer: "yes" },
      },
    };
    const command: InteractionResponseCommand = {
      ...commandMaterial,
      commandDigest: interactionResponseCommandDigest(commandMaterial),
    };
    for (const name of ["environment response", "session response"]) {
      const report = await runInteractionResponseConformance({
        name,
        request,
        command,
        statusCases: interactionStatusCases(command, request),
        respond: interactionResponder(command, request),
      });

      expect(report.checked).toEqual([
        "wrong-bindings",
        "invalid-response",
        "accepted",
        "operation-replay",
        "same-response",
        "different-response-conflict",
        "expired",
        "cancelled",
        "transport_failure",
      ]);
    }
  });
});

describe("runSessionReplayConformance", () => {
  it("proves detach and cursor replay through a reconstructed client", async () => {
    const controlRef = {
      runId: "run-detached",
      provider: "replay-fake",
      environmentId: "environment-1",
      sessionId: "session-1",
      executionId: "execution-1",
      requestDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
    };
    const events = [
      { id: "event-1", type: "status", data: { status: "processing" } },
      { id: "event-2", type: "result", data: { finalText: "ok" } },
    ];
    const makeSession = () => ({
      id: "session-1",
      controlRef,
      status: async () => "completed" as const,
      async *events(options?: { since?: string }) {
        const start = options?.since
          ? events.findIndex((event) => event.id === options.since) + 1
          : 0;
        for (const event of events.slice(start)) yield event;
      },
      result: async () => ({ text: "ok", success: true }),
      prompt: async () => ({ text: "ok", success: true }),
      cancel: async () => {},
    });
    const provider: AgentEnvironmentProvider = {
      name: "replay-fake",
      capabilities: () => ({
        ...disabledCapabilities(),
        streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
        sessions: { continue: true, list: false, messages: true },
      }),
      async create() {
        return {
          id: "environment-1",
          provider: "replay-fake",
          status: async () => "running",
          async *stream() {
            for (const event of events) yield event;
          },
          dispatch: async () => ({ id: "session-1", provider: "replay-fake", controlRef }),
          session: () => makeSession(),
          destroy: async () => {},
        };
      },
    };

    const report = await runSessionReplayConformance({
      name: "replay-fake",
      createProvider: () => provider,
      turn: { prompt: "ok", turnId: "turn-1" },
      reconnect: () => makeSession(),
    });
    expect(report).toMatchObject({
      sessionId: "session-1",
      eventIds: ["event-1", "event-2"],
      checked: [
        "detach-control-reference",
        "competing-run-isolation",
        "stable-event-ids",
        "same-client-replay",
        "reconnected-replay",
      ],
    });
  });

  it("rejects initial and reconnected session identity mismatches", async () => {
    const controlRef = {
      runId: "run-detached",
      provider: "replay-fake",
      environmentId: "environment-1",
      sessionId: "session-1",
      executionId: "execution-1",
      requestDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
    };
    const events = [
      { id: "event-1", type: "status", data: { status: "processing" } },
      { id: "event-2", type: "result", data: { finalText: "ok" } },
    ];
    const makeSession = (id: string) => ({
      id,
      controlRef,
      status: async () => "completed" as const,
      async *events(options?: { since?: string }) {
        const start = options?.since
          ? events.findIndex((event) => event.id === options.since) + 1
          : 0;
        for (const event of events.slice(start)) yield event;
      },
      result: async () => ({ text: "ok", success: true }),
      prompt: async () => ({ text: "ok", success: true }),
      cancel: async () => {},
    });
    const run = (initialSessionId: string, reconnectedSessionId: string) => {
      const provider: AgentEnvironmentProvider = {
        name: "replay-fake",
        capabilities: () => ({
          ...disabledCapabilities(),
          streaming: {
            live: true,
            replay: true,
            detach: true,
            turnIdempotency: true,
          },
          sessions: { continue: true, list: false, messages: true },
        }),
        async create() {
          return {
            id: "environment-1",
            provider: "replay-fake",
            status: async () => "running",
            async *stream() {
              for (const event of events) yield event;
            },
            dispatch: async () => ({
              id: "session-1",
              provider: "replay-fake",
              controlRef,
            }),
            session: () => makeSession(initialSessionId),
            destroy: async () => {},
          };
        },
      };
      return runSessionReplayConformance({
        name: "replay-fake",
        createProvider: () => provider,
        turn: { prompt: "ok", turnId: "turn-1" },
        reconnect: () => makeSession(reconnectedSessionId),
      });
    };

    await expect(run("wrong-session", "session-1")).rejects.toThrow(
      /session control reference differs from dispatch/,
    );
    await expect(run("session-1", "wrong-session")).rejects.toThrow(
      /reconnected session identity differs from dispatch/,
    );
  });
});

describe("runPortableContextConformance", () => {
  it("proves pure planning, exact receipt, and boundary-safe continuation", async () => {
    const source = portableSource();
    const plan = portablePlan(source);
    const run = {
      runId: "run-source",
      provider: "cli-bridge",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
    };
    const proof: NativeContextBoundaryProof = {
      runId: run.runId,
      provider: run.provider,
      environmentId: run.environmentId,
      sessionId: run.sessionId,
      executionId: run.executionId,
      requestDigest: run.requestDigest,
      boundary: {
        kind: "messages",
        messageIds: source.messages.map((message) => message.id),
        digest: source.digest,
      },
      observedAt: "2026-08-01T20:05:00.000Z",
    };
    const counters = {
      plans: 0,
      transfers: 0,
      freshSessions: 0,
      nativeContinuations: 0,
    };

    const report = await runPortableContextConformance({
      name: "in-memory context port",
      request: portablePlanRequest(
        "context-1",
        source,
        plan.destination,
        32_000,
      ),
      rejectionRequest: portablePlanRequest(
        "context-over-limit",
        source,
        plan.destination,
        1,
      ),
      run,
      acceptedAt: "2026-08-01T20:06:00.000Z",
      turn: { prompt: "Continue from the retained session." },
      async plan(request) {
        counters.plans += 1;
        if (request.requestId === "context-over-limit") {
          return {
            status: "over_limit",
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            estimatedTokens: plan.estimatedTokens,
            maxInputTokens: request.maxInputTokens!,
            suggestedBoundaryMessageId: "message-1",
            message: "context exceeds the destination limit",
          };
        }
        return {
          status: "ready",
          requestId: request.requestId,
          requestDigest: request.requestDigest,
          plan,
        };
      },
      transfer: contextTransferResponder(counters),
      async boundary() {
        return proof;
      },
      continueNative: nativeContinuationResponder(proof, counters),
      counters: () => ({ ...counters }),
    });

    expect(report.checked).toEqual([
      "side-effect-free-plan",
      "rejected-plan-zero-dispatch",
      "mismatched-plan-zero-dispatch",
      "accepted-transfer-receipt",
      "transfer-replay-conflict",
      "continuation-boundary-rejection",
      "verified-native-continuation",
      "continuation-replay-conflict",
    ]);
    expect(counters).toEqual({
      plans: 2,
      transfers: 1,
      freshSessions: 1,
      nativeContinuations: 1,
    });
  });
});

function contextTransferResponder(counters: {
  transfers: number;
  freshSessions: number;
}) {
  const operations = new Map<
    string,
    { requestDigest: `sha256:${string}`; receipt: ContextTransferReceipt }
  >();
  return async (request: ContextTransferRequest) => {
    const prior = operations.get(request.operationId);
    if (prior) {
      if (prior.requestDigest !== request.requestDigest) {
        return {
          status: "conflict" as const,
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          existingRequestDigest: prior.requestDigest as `sha256:${string}`,
        };
      }
      return { ...prior.receipt, status: "replayed" as const };
    }
        counters.transfers += 1;
        counters.freshSessions += 1;
    const receipt = {
          status: "accepted" as const,
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          planDigest: request.plan.digest,
          contextDigest: request.plan.context.digest,
          source: request.plan.source.source,
          destination: request.plan.destination,
          provider: request.plan.destination.provider,
          environmentId: request.plan.destination.environmentId,
          sessionId: request.plan.destination.sessionId,
          runId: request.plan.destination.runId,
          executionId: request.plan.destination.executionId,
          sessionCreatedForOperationId: request.operationId,
          sessionCreatedAt: "2026-08-01T20:06:00.500Z",
          transferredMessageIds: ["message-1"],
          omittedMessageIds: ["message-2"],
          admittedAt: "2026-08-01T20:06:01.000Z",
        };
    operations.set(request.operationId, {
      requestDigest: request.requestDigest,
      receipt,
    });
    return receipt;
  };
}

function nativeContinuationResponder(
  proof: NativeContextBoundaryProof,
  counters: { nativeContinuations: number },
) {
  const operations = new Map<
    string,
    {
      requestDigest: `sha256:${string}`;
      outcome: Extract<
        AgentNativeContextContinuationResult,
        { result: unknown }
      >;
    }
  >();
  return async (
    request: NativeContextContinuationRequest,
    options: AgentNativeContextContinuationOptions,
  ) => {
    if (
      request.turnDigest !==
      nativeContextContinuationTurnDigest(options.turn)
    ) {
      throw new Error(
        "native continuation request does not bind the supplied turn",
      );
    }
    const prior = operations.get(request.operationId);
    if (prior) {
      if (prior.requestDigest !== request.requestDigest) {
        return {
          acknowledgement: {
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            existingRequestDigest: prior.requestDigest,
            status: "conflict" as const,
            historyMessagesSent: 0,
          },
        };
      }
      return {
        ...prior.outcome,
        acknowledgement: {
          ...prior.outcome.acknowledgement,
          status: "replayed" as const,
        },
      };
    }
    if (
      JSON.stringify(request.expectedBoundary.boundary) !==
      JSON.stringify(proof.boundary)
    ) {
      return {
        acknowledgement: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          status: "boundary_mismatch" as const,
          historyMessagesSent: 0,
          actualBoundary: proof,
        },
      };
    }
    counters.nativeContinuations += 1;
    const acknowledgement = {
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      status: "accepted" as const,
      historyMessagesSent: 0,
      actualBoundary: proof,
    };
    const controlRef = {
      runId: `${request.run.runId}-continued`,
      provider: request.run.provider,
      environmentId: request.run.environmentId,
      sessionId: request.run.sessionId,
      executionId: `${request.operationId}-execution`,
      requestDigest: request.requestDigest,
    };
    const outcome = {
      acknowledgement,
      result: {
        text: "continued",
        success: true,
        sessionId: request.run.sessionId,
      },
      controlRef,
    } satisfies AgentNativeContextContinuationResult;
    operations.set(request.operationId, {
      requestDigest: request.requestDigest,
      outcome,
    });
    return outcome;
  };
}

describe("runWorkspaceBranchingConformance", () => {
  it("proves retry recovery, conflict rejection, and cleanup", async () => {
    const source = {
      runId: "run-1",
      provider: "tangle",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
    };
    const checkpointMaterial = {
      source,
      name: "source boundary",
      metadata: { branchId: "branch-source" },
    };
    const checkpointRequest = {
      ...checkpointMaterial,
      idempotencyKey: "checkpoint-operation-1",
      requestDigest: workspaceCheckpointRequestDigest(checkpointMaterial),
    };
    const operations = inMemoryWorkspaceBranching();

    const report = await runWorkspaceBranchingConformance({
      name: "in-memory workspace port",
      operations,
      checkpointRequest,
      forkRequest(checkpoint) {
        const material = {
          checkpoint,
          name: "destination branch",
          metadata: { branchId: "branch-destination" },
          placement: { kind: "sandbox" as const, sandboxId: "sandbox-destination", region: "us-west" },
        };
        return {
          ...material,
          idempotencyKey: "fork-operation-1",
          requestDigest: workspaceForkRequestDigest(material),
        };
      },
    });

    expect(report).toMatchObject({
      checkpointId: "checkpoint-1",
      environmentId: "environment-fork-1",
      checked: [
        "checkpoint-retry",
        "checkpoint-recovery",
        "checkpoint-conflict",
        "fork-retry",
        "fork-recovery",
        "fork-conflict",
        "cleanup-dependency-order",
        "cleanup-operation-conflict",
        "confirmed-cleanup",
        "cleanup-lookup",
      ],
    });
  });

  it("deletes a created checkpoint when a later check fails", async () => {
    const source = {
      runId: "run-cleanup-checkpoint",
      provider: "tangle",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
    };
    const material = { source, name: "source boundary" };
    const checkpointRequest = {
      ...material,
      idempotencyKey: "checkpoint-cleanup-failure",
      requestDigest: workspaceCheckpointRequestDigest(material),
    };
    const base = inMemoryWorkspaceBranching();
    let deleteCheckpointCalls = 0;
    const operations: AgentWorkspaceBranching = {
      ...base,
      async lookupCheckpoint() {
        throw new Error("injected checkpoint lookup failure");
      },
      async deleteCheckpoint(request) {
        deleteCheckpointCalls += 1;
        return base.deleteCheckpoint(request);
      },
    };

    await expect(
      runWorkspaceBranchingConformance({
        name: "checkpoint failure cleanup",
        operations,
        checkpointRequest,
        forkRequest: workspaceForkRequest,
      }),
    ).rejects.toThrow(/injected checkpoint lookup failure/);
    expect(deleteCheckpointCalls).toBe(1);
  });

  it("deletes both created resources when a post-fork check fails", async () => {
    const source = {
      runId: "run-cleanup-fork",
      provider: "tangle",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
    };
    const material = { source, name: "source boundary" };
    const checkpointRequest = {
      ...material,
      idempotencyKey: "checkpoint-fork-cleanup-failure",
      requestDigest: workspaceCheckpointRequestDigest(material),
    };
    const base = inMemoryWorkspaceBranching();
    let deleteCheckpointCalls = 0;
    let destroyForkCalls = 0;
    const cleanupOrder: string[] = [];
    const operations: AgentWorkspaceBranching = {
      ...base,
      async lookupFork() {
        throw new Error("injected fork lookup failure");
      },
      async deleteCheckpoint(request) {
        deleteCheckpointCalls += 1;
        cleanupOrder.push("checkpoint");
        return base.deleteCheckpoint(request);
      },
      async destroyFork(request) {
        destroyForkCalls += 1;
        cleanupOrder.push("fork");
        return base.destroyFork(request);
      },
    };

    await expect(
      runWorkspaceBranchingConformance({
        name: "fork failure cleanup",
        operations,
        checkpointRequest,
        forkRequest: workspaceForkRequest,
      }),
    ).rejects.toThrow(/injected fork lookup failure/);
    expect(deleteCheckpointCalls).toBe(1);
    expect(destroyForkCalls).toBe(1);
    expect(cleanupOrder).toEqual(["fork", "checkpoint"]);
  });

  it("recovers and deletes a checkpoint after its create response is lost", async () => {
    const source = {
      runId: "run-lost-checkpoint-response",
      provider: "tangle",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
    };
    const material = { source, name: "source boundary" };
    const checkpointRequest = {
      ...material,
      idempotencyKey: "checkpoint-lost-response",
      requestDigest: workspaceCheckpointRequestDigest(material),
    };
    const base = inMemoryWorkspaceBranching();
    let loseResponse = true;
    let deleteCheckpointCalls = 0;
    const operations: AgentWorkspaceBranching = {
      ...base,
      async checkpoint(request) {
        const result = await base.checkpoint(request);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("injected lost checkpoint response");
        }
        return result;
      },
      async deleteCheckpoint(request) {
        deleteCheckpointCalls += 1;
        return base.deleteCheckpoint(request);
      },
    };

    await expect(
      runWorkspaceBranchingConformance({
        name: "lost checkpoint response cleanup",
        operations,
        checkpointRequest,
        forkRequest: workspaceForkRequest,
      }),
    ).rejects.toThrow(/injected lost checkpoint response/);
    expect(deleteCheckpointCalls).toBe(1);
    await expect(
      base.lookupCheckpoint({
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
      }),
    ).resolves.toMatchObject({ status: "not_found" });
  });

  it("recovers and deletes a fork after its create response is lost", async () => {
    const source = {
      runId: "run-lost-fork-response",
      provider: "tangle",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
    };
    const material = { source, name: "source boundary" };
    const checkpointRequest = {
      ...material,
      idempotencyKey: "checkpoint-before-lost-fork-response",
      requestDigest: workspaceCheckpointRequestDigest(material),
    };
    const base = inMemoryWorkspaceBranching();
    let loseResponse = true;
    let deleteCheckpointCalls = 0;
    let destroyForkCalls = 0;
    const operations: AgentWorkspaceBranching = {
      ...base,
      async fork(request) {
        const result = await base.fork(request);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("injected lost fork response");
        }
        return result;
      },
      async deleteCheckpoint(request) {
        deleteCheckpointCalls += 1;
        return base.deleteCheckpoint(request);
      },
      async destroyFork(request) {
        destroyForkCalls += 1;
        return base.destroyFork(request);
      },
    };

    await expect(
      runWorkspaceBranchingConformance({
        name: "lost fork response cleanup",
        operations,
        checkpointRequest,
        forkRequest: workspaceForkRequest,
      }),
    ).rejects.toThrow(/injected lost fork response/);
    expect(deleteCheckpointCalls).toBe(1);
    expect(destroyForkCalls).toBe(1);
    const forkRequest = workspaceForkRequest({
      checkpointId: "checkpoint-1",
      provider: "tangle",
      source,
      idempotencyKey: checkpointRequest.idempotencyKey,
      requestDigest: checkpointRequest.requestDigest,
      createdAt: "2026-08-01T20:10:00.000Z",
    });
    await expect(
      base.lookupFork({
        idempotencyKey: forkRequest.idempotencyKey,
        requestDigest: forkRequest.requestDigest,
      }),
    ).resolves.toMatchObject({ status: "not_found" });
  });

  it("never deletes an unbound checkpoint returned by a provider", async () => {
    const source = {
      runId: "run-forged-checkpoint",
      provider: "tangle",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
    };
    const material = { source, name: "source boundary" };
    const checkpointRequest = {
      ...material,
      idempotencyKey: "checkpoint-forged-response",
      requestDigest: workspaceCheckpointRequestDigest(material),
    };
    const base = inMemoryWorkspaceBranching();
    let deleteCheckpointCalls = 0;
    const operations: AgentWorkspaceBranching = {
      ...base,
      checkpoint: async () => ({
        status: "created",
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
        checkpoint: {
          checkpointId: "victim-checkpoint",
          provider: source.provider,
          source: { ...source, environmentId: "victim-environment" },
          idempotencyKey: checkpointRequest.idempotencyKey,
          requestDigest: checkpointRequest.requestDigest,
          createdAt: "2026-08-01T20:10:00.000Z",
        },
      }),
      async deleteCheckpoint(request) {
        deleteCheckpointCalls += 1;
        return base.deleteCheckpoint(request);
      },
    };

    await expect(
      runWorkspaceBranchingConformance({
        name: "forged checkpoint cleanup",
        operations,
        checkpointRequest,
        forkRequest: workspaceForkRequest,
      }),
    ).rejects.toThrow(/checkpoint must match the exact create request/);
    expect(deleteCheckpointCalls).toBe(0);
  });

  it("never deletes an unbound fork returned by a provider", async () => {
    const source = {
      runId: "run-forged-fork",
      provider: "tangle",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
    };
    const material = { source, name: "source boundary" };
    const checkpointRequest = {
      ...material,
      idempotencyKey: "checkpoint-before-forged-fork",
      requestDigest: workspaceCheckpointRequestDigest(material),
    };
    const base = inMemoryWorkspaceBranching();
    let deleteCheckpointCalls = 0;
    let destroyForkCalls = 0;
    const operations: AgentWorkspaceBranching = {
      ...base,
      async fork(request) {
        return {
          status: "created",
          idempotencyKey: request.idempotencyKey,
          requestDigest: request.requestDigest,
          environment: {
            environmentId: "victim-fork",
            provider: request.checkpoint.provider,
            sourceEnvironmentId: request.checkpoint.source.environmentId,
            source: request.checkpoint.source,
            sourceCheckpointId: "victim-checkpoint",
            idempotencyKey: request.idempotencyKey,
            requestDigest: request.requestDigest,
            createdAt: "2026-08-01T20:10:00.000Z",
            placement: request.placement,
            confidentialRequested: false,
            confidential: false,
          },
        };
      },
      async deleteCheckpoint(request) {
        deleteCheckpointCalls += 1;
        return base.deleteCheckpoint(request);
      },
      async destroyFork(request) {
        destroyForkCalls += 1;
        return base.destroyFork(request);
      },
    };

    await expect(
      runWorkspaceBranchingConformance({
        name: "forged fork cleanup",
        operations,
        checkpointRequest,
        forkRequest: workspaceForkRequest,
      }),
    ).rejects.toThrow(/environment fork must match the exact create request/);
    expect(destroyForkCalls).toBe(0);
    expect(deleteCheckpointCalls).toBe(1);
  });
});

function workspaceForkRequest(checkpoint: WorkspaceCheckpointRef) {
  const material = {
    checkpoint,
    name: "destination branch",
    placement: { kind: "sandbox" as const, sandboxId: "sandbox-destination", region: "us-west" },
  };
  return {
    ...material,
    idempotencyKey: "fork-cleanup-failure",
    requestDigest: workspaceForkRequestDigest(material),
  };
}

describe("capability denial", () => {
  it("rejects malformed capabilities before creating an environment", async () => {
    let createCalls = 0;
    const provider: AgentEnvironmentProvider = {
      name: "malformed-capabilities",
      capabilities: () => ({
        ...disabledCapabilities(),
        workspace: {
          ...disabledCapabilities().workspace,
          read: "yes",
        },
      }) as never,
      async create() {
        createCalls += 1;
        throw new Error("must not create");
      },
    };

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "malformed-capabilities",
        createProvider: () => provider,
      }),
    ).rejects.toThrow();
    expect(createCalls).toBe(0);
  });

  it("requires methods whose capabilities are disabled to be absent", async () => {
    const provider: AgentEnvironmentProvider = {
      name: "denial-fake",
      capabilities: () => disabledCapabilities(),
      async create() {
        return {
          id: "environment-1",
          provider: "denial-fake",
          status: async () => "running",
          async *stream() {
            yield { type: "result", data: { finalText: "ok" } };
          },
          destroy: async () => {},
        };
      },
    };

    const report = await runAgentEnvironmentProviderConformance({
      name: "denial-fake",
      createProvider: () => provider,
    });
    expect(report.checked).toContain("capability-denial");
    expect(report.checked).toContain("capability-exposure");
  });

  it("rejects a disabled operation that remains exposed", async () => {
    const provider: AgentEnvironmentProvider = {
      name: "overexposed-fake",
      capabilities: () => disabledCapabilities(),
      async create() {
        return {
          id: "environment-1",
          provider: "overexposed-fake",
          status: async () => "running",
          async *stream() {
            yield { type: "result", data: { finalText: "ok" } };
          },
          dispatch: async () => ({ id: "session-1" }),
          destroy: async () => {},
        };
      },
    };

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "overexposed-fake",
        createProvider: () => provider,
      }),
    ).rejects.toThrow(/streaming.detach is disabled/);
  });

  it("rejects native continuation capability without its session operation", async () => {
    const provider: AgentEnvironmentProvider = {
      name: "missing-native-continuation",
      capabilities: () => ({
        ...disabledCapabilities(),
        sessions: { continue: true, list: false, messages: false },
        nativeContinuation: {
          atomicBoundary: true,
          requestIdempotency: true,
        },
      }),
      async create() {
        return {
          id: "environment-1",
          provider: "missing-native-continuation",
          status: async () => "running",
          async *stream() {
            yield { type: "result", data: { finalText: "ok" } };
          },
          session: (id) => ({
            id,
            status: async () => null,
            async *events() {},
            result: async () => ({ text: "ok", success: true }),
            prompt: async () => ({ text: "ok", success: true }),
            contextBoundary: async () => null,
            cancel: async () => {},
          }),
          destroy: async () => {},
        };
      },
    };

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "missing-native-continuation",
        createProvider: () => provider,
      }),
    ).rejects.toThrow(/requires session\.continueNative/);
  });

  it("rejects partial durable-branch operations and still destroys the environment", async () => {
    let destroyed = 0;
    const provider: AgentEnvironmentProvider = {
      name: "partial-branching",
      capabilities: () => ({
        ...disabledCapabilities(),
        branching: {
          checkpoint: true,
          fork: true,
          retrySafe: true,
          lookup: true,
          cleanup: true,
        },
      }),
      async create() {
        return {
          id: "environment-1",
          provider: "partial-branching",
          status: async () => "running",
          async *stream() {
            yield { type: "result", data: { finalText: "ok" } };
          },
          checkpoint: async () => ({ id: "checkpoint-1" }),
          fork: async () => {
            throw new Error("must not be called");
          },
          workspaceBranching: {
            checkpoint: async () => {
              throw new Error("must not be called");
            },
          } as unknown as AgentWorkspaceBranching,
          destroy: async () => {
            destroyed += 1;
          },
        };
      },
    };

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "partial-branching",
        createProvider: () => provider,
      }),
    ).rejects.toThrow(/lookupCheckpoint/);
    expect(destroyed).toBe(1);
  });

  it("destroys an environment when a stream assertion fails", async () => {
    let destroyed = 0;
    const provider: AgentEnvironmentProvider = {
      name: "failing-stream",
      capabilities: () => disabledCapabilities(),
      async create() {
        return {
          id: "environment-1",
          provider: "failing-stream",
          status: async () => "running",
          async *stream() {
            yield { type: "status", data: { status: "processing" } };
          },
          destroy: async () => {
            destroyed += 1;
          },
        };
      },
    };

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "failing-stream",
        createProvider: () => provider,
      }),
    ).rejects.toThrow(/terminal/);
    expect(destroyed).toBe(1);
  });

  it("reports both the check failure and environment cleanup failure", async () => {
    const provider: AgentEnvironmentProvider = {
      name: "double-failure",
      capabilities: () => disabledCapabilities(),
      async create() {
        return {
          id: "",
          provider: "double-failure",
          status: async () => "running",
          async *stream() {},
          destroy: async () => {
            throw new Error("injected destroy failure");
          },
        };
      },
    };

    let failure: unknown;
    try {
      await runAgentEnvironmentProviderConformance({
        name: "double-failure",
        createProvider: () => provider,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual([
      "environment.id must be non-empty",
      "injected destroy failure",
    ]);
  });

  it("destroys an environment when detached replay validation fails", async () => {
    let destroyed = 0;
    const provider: AgentEnvironmentProvider = {
      name: "failing-replay",
      capabilities: () => ({
        ...disabledCapabilities(),
        streaming: {
          live: true,
          replay: true,
          detach: true,
          turnIdempotency: true,
        },
      }),
      async create() {
        return {
          id: "environment-1",
          provider: "failing-replay",
          status: async () => "running",
          async *stream() {},
          dispatch: async () => ({
            id: "session-1",
            provider: "failing-replay",
          }),
          session: () => {
            throw new Error("must not be reached");
          },
          destroy: async () => {
            destroyed += 1;
          },
        };
      },
    };

    await expect(
      runSessionReplayConformance({
        name: "failing-replay",
        createProvider: () => provider,
        turn: { prompt: "ok" },
        reconnect: () => {
          throw new Error("must not be reached");
        },
      }),
    ).rejects.toThrow(/durable control reference/);
    expect(destroyed).toBe(1);
  });
});

function interactionResponder(
  expected: InteractionResponseCommand,
  request: InteractionRequest,
) {
  const operations = new Map<string, { digest: string; acknowledgement: InteractionAcknowledgement }>();
  let resolvedDigest: string | undefined;
  return async (command: InteractionResponseCommand): Promise<InteractionAcknowledgement> => {
    const digest = JSON.stringify({
      binding: command.binding,
      response: command.response,
    });
    const acknowledgement = (
      status: InteractionAcknowledgement["status"],
      message?: string,
      retryable?: boolean,
    ): InteractionAcknowledgement => ({
      operationId: command.operationId,
      binding: command.binding,
      commandDigest: command.commandDigest,
      status,
      ...(message ? { message } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
    });
    if (command.operationId.endsWith("-expired")) {
      return acknowledgement("expired");
    }
    if (command.operationId.endsWith("-cancelled")) {
      return acknowledgement("cancelled");
    }
    if (command.operationId.endsWith("-transport-failure")) {
      return acknowledgement(
        "transport_failure",
        "test transport is unavailable",
        true,
      );
    }
    const priorOperation = operations.get(command.operationId);
    if (priorOperation) {
      return priorOperation.digest === digest
        ? priorOperation.acknowledgement
        : acknowledgement("already_resolved_different");
    }
    if (command.binding.runId !== expected.binding.runId) {
      return acknowledgement("unknown_run");
    }
    if (
      command.binding.environmentId !== expected.binding.environmentId ||
      command.binding.sessionId !== expected.binding.sessionId
    ) {
      return acknowledgement("binding_mismatch");
    }
    if (command.binding.interactionId !== expected.binding.interactionId) {
      return acknowledgement("unknown_interaction");
    }
    const validation = validateInteractionResponse(request, command.response);
    if (!validation.ok) {
      return acknowledgement("invalid_response", validation.errors.join("; "));
    }
    const result = resolvedDigest
      ? acknowledgement(
          resolvedDigest === digest
            ? "already_resolved_same"
            : "already_resolved_different",
        )
      : acknowledgement("accepted");
    if (!resolvedDigest) resolvedDigest = digest;
    operations.set(command.operationId, { digest, acknowledgement: result });
    return result;
  };
}

function interactionStatusCases(
  command: InteractionResponseCommand,
  request: InteractionRequest,
) {
  return (["expired", "cancelled", "transport_failure"] as const).map(
    (expectedStatus) => ({
      request,
      command: {
        ...command,
        operationId: `${command.operationId}-${expectedStatus.replaceAll("_", "-")}`,
      },
      expectedStatus,
    }),
  );
}

function portableSource(): PortableConversationContext {
  const material = {
    source: {
      runId: "run-source",
      messageId: "message-2",
      provider: "cli-bridge",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
    },
    completeness: "complete" as const,
    messages: [
      {
        id: "message-1",
        role: "user" as const,
        parts: [{ type: "text", text: "Continue this task." }],
        timestamp: "2026-08-01T20:00:00.000Z",
      },
      {
        id: "message-2",
        role: "assistant" as const,
        parts: [{ type: "reasoning", text: "runner-private" }],
        timestamp: "2026-08-01T20:00:01.000Z",
      },
    ],
    attachments: [],
  };
  return { ...material, digest: portableConversationContextDigest(material) };
}

function portablePlanRequest(
  requestId: string,
  source: PortableConversationContext,
  destination: PortableContextPlan["destination"],
  maxInputTokens: number,
): PortableContextPlanRequest {
  const material = { requestId, source, destination, maxInputTokens };
  return {
    requestDigest: portableContextPlanRequestDigest(material),
    ...material,
  };
}

function portablePlan(source: PortableConversationContext): PortableContextPlan {
  const contextMaterial = {
    source: source.source,
    completeness: "partial" as const,
    messages: [source.messages[0]!],
    attachments: [],
  };
  const context = {
    ...contextMaterial,
    digest: portableConversationContextDigest(contextMaterial),
  };
  const material = {
    planId: "plan-1",
    source,
    destination: {
      runner: "codex",
      provider: "cli-bridge",
      environmentId: "environment-destination",
      sessionId: "session-fresh",
      runId: "run-fresh",
      executionId: "execution-fresh",
      profileDigest: `sha256:${"c".repeat(64)}` as `sha256:${string}`,
    },
    messages: [
      {
        messageId: "message-1",
        action: "include" as const,
        parts: [{ partIndex: 0, action: "include" as const }],
      },
      {
        messageId: "message-2",
        action: "omit" as const,
        reason: "runner-private reasoning is not portable",
        parts: [
          {
            partIndex: 0,
            action: "omit" as const,
            reason: "runner-private reasoning is not portable",
          },
        ],
      },
    ],
    context,
    estimatedTokens: 5,
    requiresAcceptance: true,
  };
  return { ...material, digest: portableContextPlanDigest(material) };
}

function inMemoryWorkspaceBranching(): AgentWorkspaceBranching {
  const checkpoints = new Map<string, WorkspaceCheckpointRef>();
  const cleanupOperations = new Map<string, `sha256:${string}`>();
  const forks = new Map<string, {
    provider: string;
    environmentId: string;
    sourceEnvironmentId: string;
    source: WorkspaceCheckpointRef["source"];
    sourceCheckpointId: string;
    idempotencyKey: string;
    requestDigest: `sha256:${string}`;
    createdAt: string;
    placement: WorkspaceForkRequest["placement"];
    confidentialRequested: boolean;
    confidential: boolean;
    metadata?: Record<string, unknown>;
  }>();
  return {
    async checkpoint(request) {
      const existing = checkpoints.get(request.idempotencyKey);
      if (existing) {
        if (existing.requestDigest !== request.requestDigest) {
          return {
            status: "conflict",
            idempotencyKey: request.idempotencyKey,
            requestDigest: request.requestDigest,
            existingRequestDigest: existing.requestDigest,
          };
        }
        return {
          status: "replayed",
          idempotencyKey: request.idempotencyKey,
          requestDigest: request.requestDigest,
          checkpoint: existing,
        };
      }
      const checkpoint: WorkspaceCheckpointRef = {
        checkpointId: "checkpoint-1",
        provider: request.source.provider,
        source: request.source,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        createdAt: "2026-08-01T20:10:00.000Z",
        metadata: request.metadata,
      };
      checkpoints.set(request.idempotencyKey, checkpoint);
      return {
        status: "created",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        checkpoint,
      };
    },
    async lookupCheckpoint(request) {
      const checkpoint = checkpoints.get(request.idempotencyKey);
      if (!checkpoint) return { status: "not_found", ...request };
      if (checkpoint.requestDigest !== request.requestDigest) {
        return {
          status: "conflict",
          ...request,
          existingRequestDigest: checkpoint.requestDigest,
        };
      }
      return { status: "found", ...request, checkpoint };
    },
    async deleteCheckpoint(request) {
      const priorDigest = cleanupOperations.get(request.operationId);
      if (priorDigest !== undefined && priorDigest !== request.requestDigest) {
        return {
          operationId: request.operationId,
          kind: request.kind,
          targetId: request.targetId,
          provider: request.provider,
          requestDigest: request.requestDigest,
          status: "conflict",
          existingRequestDigest: priorDigest,
          message: "cleanup operation was reused with different input",
        };
      }
      cleanupOperations.set(request.operationId, request.requestDigest);
      const entry = [...checkpoints.entries()].find(
        ([, checkpoint]) => checkpoint.checkpointId === request.targetId,
      );
      if (!entry) {
      return {
        operationId: request.operationId,
        kind: request.kind,
        targetId: request.targetId,
        provider: request.provider,
        requestDigest: request.requestDigest,
        status: "already_absent",
        };
      }
      const blockingTargetIds = [...forks.values()]
        .filter(
          (environment) =>
            environment.sourceCheckpointId === entry[1].checkpointId,
        )
        .map((environment) => environment.environmentId)
        .sort();
      if (blockingTargetIds.length > 0) {
        return {
          operationId: request.operationId,
          kind: request.kind,
          targetId: request.targetId,
          provider: request.provider,
          requestDigest: request.requestDigest,
          status: "in_use",
          message: "forked environments still depend on this checkpoint",
          blockingTargetIds,
        };
      }
      checkpoints.delete(entry[0]);
      return {
        operationId: request.operationId,
        kind: request.kind,
        targetId: request.targetId,
        provider: request.provider,
        requestDigest: request.requestDigest,
        status: "deleted",
      };
    },
    async fork(request) {
      const existing = forks.get(request.idempotencyKey);
      if (existing) {
        if (existing.requestDigest !== request.requestDigest) {
          return {
            status: "conflict",
            idempotencyKey: request.idempotencyKey,
            requestDigest: request.requestDigest,
            existingRequestDigest: existing.requestDigest,
          };
        }
        return { status: "replayed", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, environment: existing };
      }
      const environment = {
        provider: request.checkpoint.provider,
        environmentId: "environment-fork-1",
        sourceEnvironmentId: request.checkpoint.source.environmentId,
        source: request.checkpoint.source,
        sourceCheckpointId: request.checkpoint.checkpointId,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        createdAt: "2026-08-01T20:10:01.000Z",
        placement: request.placement,
        confidentialRequested: request.confidential?.requested ?? false,
        confidential: request.confidential?.requested ?? false,
        metadata: request.metadata,
      };
      forks.set(request.idempotencyKey, environment);
      return { status: "created", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, environment };
    },
    async lookupFork(request) {
      const environment = forks.get(request.idempotencyKey);
      if (!environment) return { status: "not_found", ...request };
      if (environment.requestDigest !== request.requestDigest) {
        return { status: "conflict", ...request, existingRequestDigest: environment.requestDigest };
      }
      return { status: "found", ...request, environment };
    },
    async destroyFork(request) {
      const priorDigest = cleanupOperations.get(request.operationId);
      if (priorDigest !== undefined && priorDigest !== request.requestDigest) {
        return {
          operationId: request.operationId,
          kind: request.kind,
          targetId: request.targetId,
          provider: request.provider,
          requestDigest: request.requestDigest,
          status: "conflict",
          existingRequestDigest: priorDigest,
          message: "cleanup operation was reused with different input",
        };
      }
      cleanupOperations.set(request.operationId, request.requestDigest);
      const entry = [...forks.entries()].find(
        ([, environment]) => environment.environmentId === request.targetId,
      );
      if (!entry) {
        return {
          operationId: request.operationId,
          kind: request.kind,
          targetId: request.targetId,
          provider: request.provider,
          requestDigest: request.requestDigest,
          status: "already_absent",
        };
      }
      forks.delete(entry[0]);
      return {
        operationId: request.operationId,
        kind: request.kind,
        targetId: request.targetId,
        provider: request.provider,
        requestDigest: request.requestDigest,
        status: "deleted",
      };
    },
  };
}

function disabledCapabilities() {
  return {
    profile: {
      namedProfiles: true,
      systemPrompt: { replace: true, append: true },
      instructions: true,
      tools: true,
      permissions: true,
      mcp: true,
      subagents: true,
      resources: {
        files: true,
        instructions: true,
        tools: true,
        skills: true,
        agents: true,
        commands: true,
      },
      hooks: true,
      modes: true,
      runtimeUpdate: true,
      validation: true,
    },
    streaming: { live: true, replay: false, detach: false, turnIdempotency: false },
    sessions: { continue: false, list: false, messages: false },
    workspace: { read: false, write: false, exec: false, git: false, upload: false, download: false },
    branching: { checkpoint: false, fork: false, retrySafe: false, lookup: false, cleanup: false },
    placement: false,
    usage: false,
    confidential: false,
  };
}
