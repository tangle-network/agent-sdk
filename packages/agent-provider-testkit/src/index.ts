import { isDeepStrictEqual } from "node:util";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentExactProcessEnvironment,
  AgentExactProcessLaunch,
  AgentNativeContextContinuationOptions,
  AgentNativeContextContinuationResult,
  AgentSession,
  AgentSessionRef,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
  CreateAgentExactProcessEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  AgentEnvironmentCapabilitiesSchema,
  AgentNativeContextContinuationResultSchema,
  agentNativeContextContinuationResultMatchesRequest,
} from "@tangle-network/agent-interface/environment-provider";
import {
  AgentRunControlRefSchema,
  ContextTransferResultSchema,
  ContextTransferRequestSchema,
  InteractionAcknowledgementSchema,
  InteractionRequestSchema,
  InteractionResponseCommandSchema,
  NativeContextBoundaryProofSchema,
  NativeContextContinuationRequestSchema,
  PortableContextPlanRequestSchema,
  PortableContextPlanResultSchema,
  WorkspaceCheckpointLookupResultSchema,
  WorkspaceCheckpointResultSchema,
  WorkspaceCleanupAcknowledgementSchema,
  WorkspaceForkLookupResultSchema,
  WorkspaceForkResultSchema,
  contextTransferRequestDigest,
  contextTransferReceiptMatches,
  contextTransferResultMatchesRequest,
  nativeContextContinuationAcknowledgementMatches,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
  portableContextPlanResultMatchesRequest,
  validateInteractionResponse,
  workspaceCheckpointResultMatchesRequest,
  workspaceCheckpointRequestDigest,
  workspaceCleanupAcknowledgementMatches,
  workspaceForkResultMatchesRequest,
  workspaceForkRequestDigest,
  type AgentCandidateTermination,
  type AgentRunControlRef,
  type AgentWorkspaceBranching,
  type ContextTransferResult,
  type ContextTransferRequest,
  type InteractionAcknowledgement,
  type InteractionRequest,
  type InteractionResponseCommand,
  type NativeContextBoundary,
  type NativeContextBoundaryProof,
  type NativeContextContinuationRequest,
  type NativeContextContinuationTurn,
  type PortableContextPlanRequest,
  type PortableContextPlanResult,
  type WorkspaceCheckpointRequest,
  type WorkspaceCheckpointRef,
  type WorkspaceForkRequest,
} from "@tangle-network/agent-interface";

export interface ProviderConformanceOptions {
  name: string;
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput?: Partial<CreateAgentEnvironmentInput>;
  prompt?: string;
  requireUsage?: boolean;
  requireDispatch?: boolean;
}

export interface ProviderConformanceReport {
  provider: string;
  environmentId: string;
  capabilities: AgentEnvironmentCapabilities;
  events: number;
  checked: string[];
}

export interface ExactProcessProviderLifecycleOptions {
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput: CreateAgentExactProcessEnvironmentInput;
  launch: AgentExactProcessLaunch;
  expectedStdout: string;
  expectedStderr: string;
  /** Overall wall-clock bound for one lifecycle check. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface ExactProcessProviderLifecycleReport {
  provider: string;
  environmentId: string;
  pid: number;
  checked: string[];
}

export interface InteractionResponseConformanceOptions {
  name: string;
  request: InteractionRequest;
  command: InteractionResponseCommand;
  /** Prepared interaction states needed to exercise non-happy-path outcomes. */
  statusCases: readonly InteractionResponseStatusCase[];
  respond(
    command: InteractionResponseCommand,
  ): Promise<InteractionAcknowledgement>;
}

export interface InteractionResponseStatusCase {
  request: InteractionRequest;
  command: InteractionResponseCommand;
  expectedStatus: "expired" | "cancelled" | "transport_failure";
}

export interface InteractionResponseConformanceReport {
  name: string;
  checked: string[];
}

export interface PortableContextConformanceCounters {
  plans: number;
  transfers: number;
  freshSessions: number;
  nativeContinuations: number;
}

export interface PortableContextConformanceOptions {
  name: string;
  request: PortableContextPlanRequest;
  /** A request the implementation must reject as over its exact token budget. */
  rejectionRequest: PortableContextPlanRequest;
  run: AgentRunControlRef;
  acceptedAt: string;
  turn: NativeContextContinuationTurn;
  plan(request: PortableContextPlanRequest): Promise<PortableContextPlanResult>;
  transfer(request: ContextTransferRequest): Promise<ContextTransferResult>;
  boundary(run: AgentRunControlRef): Promise<NativeContextBoundaryProof | null>;
  continueNative(
    request: NativeContextContinuationRequest,
    options: AgentNativeContextContinuationOptions,
  ): Promise<AgentNativeContextContinuationResult>;
  counters(): PortableContextConformanceCounters | Promise<PortableContextConformanceCounters>;
}

export interface PortableContextConformanceReport {
  name: string;
  planDigest: string;
  contextDigest: string;
  checked: string[];
}

export interface WorkspaceBranchingConformanceOptions {
  name: string;
  operations: AgentWorkspaceBranching;
  checkpointRequest: WorkspaceCheckpointRequest;
  forkRequest(
    checkpoint: WorkspaceCheckpointRef,
  ): WorkspaceForkRequest;
}

export interface WorkspaceBranchingConformanceReport {
  name: string;
  checkpointId: string;
  environmentId: string;
  checked: string[];
}

export interface SessionReplayConformanceOptions {
  name: string;
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput?: Partial<CreateAgentEnvironmentInput>;
  turn: AgentTurnInput;
  /** Recreate the session through a new client/environment after dispatch. */
  reconnect(
    reference: AgentSessionRef,
  ): AgentSession | Promise<AgentSession>;
}

export interface SessionReplayConformanceReport {
  name: string;
  sessionId: string;
  eventIds: string[];
  checked: string[];
}

export class ProviderConformanceError extends Error {
  constructor(
    message: string,
    readonly checked: string[],
  ) {
    super(message);
    this.name = "ProviderConformanceError";
  }
}

export async function runAgentEnvironmentProviderConformance(
  options: ProviderConformanceOptions,
): Promise<ProviderConformanceReport> {
  const checked: string[] = [];
  const provider = await options.createProvider();
  assert(provider.name, "provider.name must be non-empty", checked);
  assert(typeof provider.capabilities === "function", "provider.capabilities must be a function", checked);
  checked.push("provider-shape");

  const capabilities = AgentEnvironmentCapabilitiesSchema.parse(
    await provider.capabilities(),
  );
  assert(capabilities.profile !== undefined, "capabilities.profile is required", checked);
  assert(capabilities.streaming !== undefined, "capabilities.streaming is required", checked);
  assert(capabilities.workspace !== undefined, "capabilities.workspace is required", checked);
  checked.push("capabilities");

  const environment = await provider.create({
    profile: { name: `${options.name}-profile` },
    backend: "test",
    name: `${options.name}-environment`,
    ...(options.createInput ?? {}),
  });
  return withEnvironmentCleanup(environment, checked, async () => {
    assert(environment.id, "environment.id must be non-empty", checked);
    assert(environment.provider, "environment.provider must be non-empty", checked);
    checkCapabilityExposure(environment, capabilities, checked);
    if (capabilities.interactions) {
      assert(
        typeof environment.respondToInteraction === "function",
        "interaction capability requires respondToInteraction()",
        checked,
      );
    }
    if (
      capabilities.branching.retrySafe ||
      capabilities.branching.lookup ||
      capabilities.branching.cleanup
    ) {
      assert(
        capabilities.branching.checkpoint && capabilities.branching.fork,
        "durable branching requires checkpoint and fork capabilities",
        checked,
      );
      assert(
        capabilities.branching.retrySafe &&
          capabilities.branching.lookup &&
          capabilities.branching.cleanup,
        "durable branching idempotency, lookup, and cleanup are all-or-nothing",
        checked,
      );
      const branching = environment.workspaceBranching;
      assert(
        branching,
        "durable branching capabilities require workspaceBranching operations",
        checked,
      );
      for (const method of [
        "checkpoint",
        "lookupCheckpoint",
        "deleteCheckpoint",
        "fork",
        "lookupFork",
        "destroyFork",
      ] as const) {
        assert(
          typeof branching[method] === "function",
          `durable branching requires workspaceBranching.${method}()`,
          checked,
        );
      }
    }
    checked.push("create");

    const events = await collect(
      environment.stream({
        prompt: options.prompt ?? "Return the word ok.",
        sessionId: `${options.name}-session`,
        turnId: `${options.name}-turn`,
      }),
    );
    assert(events.length > 0, "stream must emit at least one event", checked);
    assert(
      events.some(isTerminalEvent),
      "stream must emit a terminal result/done/status event",
      checked,
    );
    if (options.requireUsage || capabilities.usage) {
      assert(
        events.some((event) => Boolean(event.usage)),
        "provider declared usage support but emitted no usage",
        checked,
      );
    }
    checked.push("stream");

    if (capabilities.nativeContinuation !== undefined) {
      assert(
        typeof environment.session === "function",
        "native continuation requires session()",
        checked,
      );
      const session = environment.session(`${options.name}-session`);
      assert(
        typeof session.contextBoundary === "function",
        "native continuation requires contextBoundary()",
        checked,
      );
      assert(
        typeof session.continueNative === "function",
        "native continuation capability requires continueNative()",
        checked,
      );
      checked.push("native-continuation-operations");
    }

    if (options.requireDispatch || capabilities.streaming.detach) {
      assert(
        typeof environment.dispatch === "function",
        "detach support requires dispatch()",
        checked,
      );
      const session = await environment.dispatch?.({
        prompt: options.prompt ?? "Return the word ok.",
        sessionId: `${options.name}-dispatch`,
      });
      assert(session?.id, "dispatch() must return a session id", checked);
      checked.push("dispatch");
    }

    await checkWorkspace(environment, capabilities, checked);
    checked.push("capability-denial");

    return {
      provider: provider.name,
      environmentId: environment.id,
      capabilities,
      events: events.length,
      checked,
    };
  }, true);
}

/** Prove detach plus stable event replay through a reconstructed session client. */
export async function runSessionReplayConformance(
  options: SessionReplayConformanceOptions,
): Promise<SessionReplayConformanceReport> {
  const checked: string[] = [];
  const provider = await options.createProvider();
  const capabilities = AgentEnvironmentCapabilitiesSchema.parse(
    await provider.capabilities(),
  );
  assert(capabilities.streaming.detach, "provider must declare detach", checked);
  assert(capabilities.streaming.replay, "provider must declare replay", checked);
  const environment = await provider.create({
    profile: { name: `${options.name}-profile` },
    name: `${options.name}-environment`,
    ...(options.createInput ?? {}),
  });
  return withEnvironmentCleanup(environment, checked, async () => {
    assert(
      typeof environment.dispatch === "function",
      "detach requires dispatch()",
      checked,
    );
    assert(
      typeof environment.session === "function",
      "replay requires session()",
      checked,
    );
    const reference = await environment.dispatch({
      ...options.turn,
      detach: true,
    });
    assert(
      reference.controlRef,
      "detached session requires a durable control reference",
      checked,
    );
    const controlRef = AgentRunControlRefSchema.parse(reference.controlRef);
    assert(
      controlRef.provider === provider.name &&
        controlRef.environmentId === environment.id &&
        controlRef.sessionId === reference.id,
      "detached control reference does not identify the dispatched session",
      checked,
    );
    const session = environment.session(reference.id, {
      controlRef,
    });
    assert(
      session.id === reference.id &&
        session.controlRef &&
        deepEqual(session.controlRef, controlRef),
      "session control reference differs from dispatch",
      checked,
    );
    checked.push("detach-control-reference");

    const competingControlRef = AgentRunControlRefSchema.parse({
      ...controlRef,
      runId: `${controlRef.runId}-competing`,
      ...(controlRef.executionId
        ? { executionId: `${controlRef.executionId}-competing` }
        : {}),
    });
    let competingRunRejected = false;
    try {
      const competingSession = environment.session(reference.id, {
        controlRef: competingControlRef,
      });
      if (!deepEqual(competingSession.controlRef, competingControlRef)) {
        competingRunRejected = true;
      } else {
        await collect(
          competingSession.events({
            ...(competingControlRef.executionId
              ? { executionId: competingControlRef.executionId }
              : {}),
          }),
        );
      }
    } catch {
      competingRunRejected = true;
    }
    assert(
      competingRunRejected,
      "session replay accepted a competing run control reference",
      checked,
    );
    checked.push("competing-run-isolation");

    const events = await collect(session.events());
    assert(events.length > 1, "replay check requires at least two events", checked);
    assert(
      events.some(isTerminalEvent),
      "session event stream must terminate",
      checked,
    );
    const eventIds = events.map((event) => event.id);
    assert(
      eventIds.every(
        (eventId) => typeof eventId === "string" && eventId.length > 0,
      ),
      "replayable session events require stable ids",
      checked,
    );
    assert(
      new Set(eventIds).size === eventIds.length,
      "replayable session event ids must be unique",
      checked,
    );
    checked.push("stable-event-ids");

    const cursor = eventIds[0]!;
    const expectedReplay = eventIds.slice(1);
    const sameClientReplay = await collect(
      session.events({
        since: cursor,
        ...(controlRef.executionId
          ? { executionId: controlRef.executionId }
          : {}),
      }),
    );
    assert(
      deepEqual(
        sameClientReplay.map((event) => event.id),
        expectedReplay,
      ),
      "same-client replay differs after cursor",
      checked,
    );
    checked.push("same-client-replay");

    const reconnected = await options.reconnect(reference);
    assert(
      reconnected.id === reference.id &&
        reconnected.controlRef &&
        deepEqual(reconnected.controlRef, controlRef),
      "reconnected session identity differs from dispatch",
      checked,
    );
    const reconnectedReplay = await collect(
      reconnected.events({
        since: cursor,
        ...(controlRef.executionId
          ? { executionId: controlRef.executionId }
          : {}),
      }),
    );
    assert(
      deepEqual(
        reconnectedReplay.map((event) => event.id),
        expectedReplay,
      ),
      "reconnected replay differs after cursor",
      checked,
    );
    checked.push("reconnected-replay");

    return {
      name: options.name,
      sessionId: reference.id,
      eventIds: eventIds as string[],
      checked,
    };
  });
}

/** Prove durable binding and idempotency for one prepared interaction. */
export async function runInteractionResponseConformance(
  options: InteractionResponseConformanceOptions,
): Promise<InteractionResponseConformanceReport> {
  const checked: string[] = [];
  const request = InteractionRequestSchema.parse(options.request);
  const command = InteractionResponseCommandSchema.parse(options.command);
  assert(
    request.id === command.binding.interactionId,
    "prepared request differs from the command binding",
    checked,
  );
  assert(
    validateInteractionResponse(request, command.response).ok,
    "prepared interaction response is invalid",
    checked,
  );

  const expectStatus = async (
    candidate: InteractionResponseCommand,
    status: InteractionAcknowledgement["status"],
  ): Promise<InteractionAcknowledgement> => {
    const acknowledgement = InteractionAcknowledgementSchema.parse(
      await options.respond(candidate),
    );
    assert(
      acknowledgement.status === status,
      `expected interaction status ${status}, received ${acknowledgement.status}`,
      checked,
    );
    assert(
      acknowledgement.operationId === candidate.operationId,
      "interaction acknowledgement operation id differs",
      checked,
    );
    assert(
      deepEqual(acknowledgement.binding, candidate.binding),
      "interaction acknowledgement binding differs",
      checked,
    );
    return acknowledgement;
  };

  await expectStatus(
    {
      ...command,
      operationId: `${command.operationId}-wrong-run`,
      binding: { ...command.binding, runId: `${command.binding.runId}-wrong` },
    },
    "unknown_run",
  );
  await expectStatus(
    {
      ...command,
      operationId: `${command.operationId}-wrong-environment`,
      binding: {
        ...command.binding,
        environmentId: `${command.binding.environmentId}-wrong`,
      },
    },
    "binding_mismatch",
  );
  if (command.binding.sessionId) {
    await expectStatus(
      {
        ...command,
        operationId: `${command.operationId}-wrong-session`,
        binding: {
          ...command.binding,
          sessionId: `${command.binding.sessionId}-wrong`,
        },
      },
      "binding_mismatch",
    );
  }
  const wrongInteractionId = `${command.binding.interactionId}-wrong`;
  await expectStatus(
    {
      ...command,
      operationId: `${command.operationId}-wrong-interaction`,
      binding: { ...command.binding, interactionId: wrongInteractionId },
      response: { ...command.response, id: wrongInteractionId },
    },
    "unknown_interaction",
  );
  checked.push("wrong-bindings");

  assert(
    command.response.outcome === "accepted",
    "interaction conformance requires an accepted response with data",
    checked,
  );
  await expectStatus(
    {
      ...command,
      operationId: `${command.operationId}-invalid-response`,
      response: {
        ...command.response,
        data: {
          ...(command.response.data ?? {}),
          "testkit-undeclared-field": "must be rejected",
        },
      },
    },
    "invalid_response",
  );
  checked.push("invalid-response");

  const accepted = await expectStatus(command, "accepted");
  checked.push("accepted");

  const replayed = await expectStatus(command, "accepted");
  assert(
    deepEqual(replayed, accepted),
    "same interaction operation must return the same acknowledgement",
    checked,
  );
  checked.push("operation-replay");

  await expectStatus(
    { ...command, operationId: `${command.operationId}-same-response` },
    "already_resolved_same",
  );
  checked.push("same-response");

  const changedResponse = {
    ...command,
    operationId: `${command.operationId}-different-response`,
    response: {
      id: command.response.id,
      outcome: "declined" as const,
    },
  };
  await expectStatus(changedResponse, "already_resolved_different");
  await expectStatus(
    { ...changedResponse, operationId: command.operationId },
    "already_resolved_different",
  );
  checked.push("different-response-conflict");

  assert(
    options.statusCases.length === 3,
    "interaction conformance requires exactly three prepared status cases",
    checked,
  );
  for (const expectedStatus of [
    "expired",
    "cancelled",
    "transport_failure",
  ] as const) {
    const prepared = options.statusCases.filter(
      (candidate) => candidate.expectedStatus === expectedStatus,
    );
    assert(
      prepared.length === 1,
      `interaction conformance requires exactly one ${expectedStatus} case`,
      checked,
    );
    const statusCase = prepared[0]!;
    const statusRequest = InteractionRequestSchema.parse(statusCase.request);
    const statusCommand = InteractionResponseCommandSchema.parse(
      statusCase.command,
    );
    assert(
      statusRequest.id === statusCommand.binding.interactionId &&
        validateInteractionResponse(statusRequest, statusCommand.response).ok,
      `${expectedStatus} case must contain a valid bound response`,
      checked,
    );
    const acknowledgement = await expectStatus(
      statusCommand,
      expectedStatus,
    );
    if (expectedStatus === "transport_failure") {
      assert(
        acknowledgement.message !== undefined &&
          acknowledgement.retryable !== undefined,
        "transport failure must explain whether retry is safe",
        checked,
      );
    }
    checked.push(expectedStatus);
  }

  return { name: options.name, checked };
}

/** Prove planning purity, digest-bound fresh transfer, and verified continuation. */
export async function runPortableContextConformance(
  options: PortableContextConformanceOptions,
): Promise<PortableContextConformanceReport> {
  const checked: string[] = [];
  const request = PortableContextPlanRequestSchema.parse(options.request);
  const before = await options.counters();
  const result = PortableContextPlanResultSchema.parse(
    await options.plan(request),
  );
  const afterPlan = await options.counters();
  assert(
    afterPlan.plans === before.plans + 1,
    "context planning counter must advance once",
    checked,
  );
  assertNoContextEffects(before, afterPlan, checked);
  assert(result.status === "ready", "context conformance requires a ready plan", checked);
  assert(
    portableContextPlanResultMatchesRequest(request, result),
    "ready context plan does not match its request or token budget",
    checked,
  );
  assertPortablePlanCoversRequest(request, result, checked);
  checked.push("side-effect-free-plan");

  const rejectionRequest = PortableContextPlanRequestSchema.parse(
    options.rejectionRequest,
  );
  assert(
    rejectionRequest.requestId !== request.requestId &&
      rejectionRequest.maxInputTokens !== undefined,
    "over-limit conformance requires a distinct request with a token budget",
    checked,
  );
  const rejection = PortableContextPlanResultSchema.parse(
    await options.plan(rejectionRequest),
  );
  assert(
    rejection.status === "over_limit" &&
      portableContextPlanResultMatchesRequest(rejectionRequest, rejection),
    "oversized context must return an exact over-limit result",
    checked,
  );
  assert(
    !portableContextPlanResultMatchesRequest(request, rejection) &&
      !portableContextPlanResultMatchesRequest(rejectionRequest, result),
    "context planning results must not match a different request",
    checked,
  );
  const afterRejection = await options.counters();
  assert(
    afterRejection.plans === afterPlan.plans + 1,
    "over-limit planning counter must advance once",
    checked,
  );
  assertNoContextEffects(before, afterRejection, checked);
  checked.push("rejected-plan-zero-dispatch");

  const mismatchedTransferMaterial = {
    plan: result.plan,
    acceptance: {
      planDigest: request.source.digest,
      acceptedAt: options.acceptedAt,
      acceptedBy: "user" as const,
    },
  };
  const mismatchedTransfer = {
    operationId: `${request.requestId}-mismatch`,
    requestDigest: contextTransferRequestDigest(mismatchedTransferMaterial),
    ...mismatchedTransferMaterial,
  };
  assert(
    !ContextTransferRequestSchema.safeParse(mismatchedTransfer).success,
    "mismatched plan digest must fail before transfer",
    checked,
  );
  assertNoContextEffects(before, await options.counters(), checked);
  checked.push("mismatched-plan-zero-dispatch");

  const transferMaterial = {
    plan: result.plan,
    acceptance: {
      planDigest: result.plan.digest,
      acceptedAt: options.acceptedAt,
      acceptedBy: "user" as const,
    },
  };
  const transferRequest = ContextTransferRequestSchema.parse({
    operationId: `${request.requestId}-transfer`,
    requestDigest: contextTransferRequestDigest(transferMaterial),
    ...transferMaterial,
  });
  const receipt = ContextTransferResultSchema.parse(
    await options.transfer(transferRequest),
  );
  assert(
    receipt.status === "accepted" &&
      contextTransferResultMatchesRequest(transferRequest, receipt) &&
      contextTransferReceiptMatches(transferRequest, receipt),
    "context transfer receipt does not match the accepted plan",
    checked,
  );
  const afterTransfer = await options.counters();
  assert(
    afterTransfer.transfers === before.transfers + 1 &&
      afterTransfer.freshSessions === before.freshSessions + 1,
    "accepted context must dispatch once into one fresh session",
    checked,
  );
  checked.push("accepted-transfer-receipt");

  const replayedTransfer = ContextTransferResultSchema.parse(
    await options.transfer(transferRequest),
  );
  assert(
    replayedTransfer.status === "replayed" &&
      contextTransferResultMatchesRequest(transferRequest, replayedTransfer) &&
      contextTransferReceiptMatches(transferRequest, replayedTransfer) &&
      replayedTransfer.environmentId === receipt.environmentId &&
      replayedTransfer.sessionId === receipt.sessionId,
    "context transfer retry must recover the original fresh session",
    checked,
  );
  assert(
    deepEqual(await options.counters(), afterTransfer),
    "context transfer retry must create no second session",
    checked,
  );
  const changedTransferMaterial = {
    ...transferMaterial,
    acceptance: { ...transferMaterial.acceptance, acceptedBy: "policy" as const },
  };
  const changedTransfer = ContextTransferRequestSchema.parse({
    operationId: transferRequest.operationId,
    requestDigest: contextTransferRequestDigest(changedTransferMaterial),
    ...changedTransferMaterial,
  });
  const transferConflict = ContextTransferResultSchema.parse(
    await options.transfer(changedTransfer),
  );
  assert(
    transferConflict.status === "conflict" &&
      contextTransferResultMatchesRequest(changedTransfer, transferConflict) &&
      transferConflict.existingRequestDigest === transferRequest.requestDigest,
    "changed transfer input must conflict with the original operation",
    checked,
  );
  assert(
    deepEqual(await options.counters(), afterTransfer),
    "context transfer conflict must dispatch nothing",
    checked,
  );
  checked.push("transfer-replay-conflict");

  const proof = NativeContextBoundaryProofSchema.parse(
    await options.boundary(options.run),
  );
  const continuationMaterial = {
    turnDigest: nativeContextContinuationTurnDigest(options.turn),
    run: options.run,
    expectedBoundary: proof,
  };
  const continuation = NativeContextContinuationRequestSchema.parse({
    operationId: `${request.requestId}-continue`,
    requestDigest: nativeContextContinuationRequestDigest(
      continuationMaterial,
    ),
    ...continuationMaterial,
  });
  const mismatchedBoundary = {
    ...proof,
    boundary: differentBoundary(proof.boundary),
  };
  const mismatchMaterial = {
    turnDigest: continuation.turnDigest,
    run: options.run,
    expectedBoundary: mismatchedBoundary,
  };
  const mismatch = NativeContextContinuationRequestSchema.parse({
    operationId: `${continuation.operationId}-mismatch`,
    requestDigest: nativeContextContinuationRequestDigest(mismatchMaterial),
    ...mismatchMaterial,
  });
  const mismatchOutcome = AgentNativeContextContinuationResultSchema.parse(
    await options.continueNative(mismatch, { turn: options.turn }),
  );
  const mismatchAck = mismatchOutcome.acknowledgement;
  assert(
    mismatchAck.status === "boundary_mismatch" &&
      !nativeContextContinuationAcknowledgementMatches(mismatch, mismatchAck),
    "changed native boundary must be rejected",
    checked,
  );
  assert(
    (await options.counters()).nativeContinuations === before.nativeContinuations,
    "boundary mismatch must dispatch no continuation",
    checked,
  );
  checked.push("continuation-boundary-rejection");

  const continuationOutcome = AgentNativeContextContinuationResultSchema.parse(
    await options.continueNative(continuation, { turn: options.turn }),
  );
  const continuationAck = continuationOutcome.acknowledgement;
  assert(
    "result" in continuationOutcome && "controlRef" in continuationOutcome,
    "accepted native continuation omitted its result or control reference",
    checked,
  );
  assert(
    continuationAck.status === "accepted" &&
      agentNativeContextContinuationResultMatchesRequest(
        continuation,
        continuationOutcome,
      ) &&
      continuationAck.historyMessagesSent === 0,
    "matching native continuation must return an exact result and current control reference",
    checked,
  );
  assert(
    (await options.counters()).nativeContinuations ===
      before.nativeContinuations + 1,
    "matching native boundary must continue exactly once",
    checked,
  );
  checked.push("verified-native-continuation");

  const afterContinuation = await options.counters();
  const replayedContinuation = AgentNativeContextContinuationResultSchema.parse(
    await options.continueNative(continuation, { turn: options.turn }),
  );
  const replayedAcknowledgement = replayedContinuation.acknowledgement;
  assert(
    "result" in replayedContinuation && "controlRef" in replayedContinuation,
    "replayed native continuation omitted its result or control reference",
    checked,
  );
  assert(
    replayedAcknowledgement.status === "replayed" &&
      agentNativeContextContinuationResultMatchesRequest(
        continuation,
        replayedContinuation,
      ) &&
      deepEqual(replayedContinuation.result, continuationOutcome.result) &&
      deepEqual(
        replayedContinuation.controlRef,
        continuationOutcome.controlRef,
      ),
    "native continuation retry must recover the original result and control reference",
    checked,
  );
  assert(
    deepEqual(await options.counters(), afterContinuation),
    "native continuation retry must dispatch nothing",
    checked,
  );
  const changedTurn = {
    ...options.turn,
    prompt: `${options.turn.prompt ?? ""} changed`,
  };
  const changedContinuationMaterial = {
    turnDigest: nativeContextContinuationTurnDigest(changedTurn),
    run: options.run,
    expectedBoundary: proof,
  };
  const changedContinuation = NativeContextContinuationRequestSchema.parse({
    operationId: continuation.operationId,
    requestDigest: nativeContextContinuationRequestDigest(
      changedContinuationMaterial,
    ),
    ...changedContinuationMaterial,
  });
  const continuationConflict = AgentNativeContextContinuationResultSchema.parse(
    await options.continueNative(changedContinuation, { turn: changedTurn }),
  ).acknowledgement;
  assert(
    continuationConflict.status === "conflict" &&
      continuationConflict.existingRequestDigest ===
        continuation.requestDigest &&
      !nativeContextContinuationAcknowledgementMatches(
        changedContinuation,
        continuationConflict,
      ),
    "changed continuation input must conflict with the original operation",
    checked,
  );
  assert(
    deepEqual(await options.counters(), afterContinuation),
    "native continuation conflict must dispatch nothing",
    checked,
  );
  checked.push("continuation-replay-conflict");

  return {
    name: options.name,
    planDigest: result.plan.digest,
    contextDigest: result.plan.context.digest,
    checked,
  };
}

/** Prove retry recovery, changed-input conflicts, and confirmed cleanup. */
export async function runWorkspaceBranchingConformance(
  options: WorkspaceBranchingConformanceOptions,
): Promise<WorkspaceBranchingConformanceReport> {
  const checked: string[] = [];
  const checkpointRequest = options.checkpointRequest;
  let checkpointRef: WorkspaceCheckpointRef | undefined;
  let forkRef: { environmentId: string; provider: string } | undefined;
  let issuedForkRequest: WorkspaceForkRequest | undefined;
  let checkpointCleanupConfirmed = false;
  let forkCleanupConfirmed = false;
  let operationError: unknown;
  try {
    const createdCheckpoint = WorkspaceCheckpointResultSchema.parse(
      await options.operations.checkpoint(checkpointRequest),
    );
    assert(
      createdCheckpoint.status === "created" &&
        workspaceCheckpointResultMatchesRequest(
          checkpointRequest,
          createdCheckpoint,
        ),
      "checkpoint must match the exact create request",
      checked,
    );
    checkpointRef = createdCheckpoint.checkpoint;
    const replayedCheckpoint = WorkspaceCheckpointResultSchema.parse(
      await options.operations.checkpoint(checkpointRequest),
    );
    assert(
      replayedCheckpoint.status === "replayed" &&
        workspaceCheckpointResultMatchesRequest(
          checkpointRequest,
          replayedCheckpoint,
        ) &&
        deepEqual(replayedCheckpoint.checkpoint, createdCheckpoint.checkpoint),
      "checkpoint retry must return the original checkpoint",
      checked,
    );
    checked.push("checkpoint-retry");

    const checkpointLookup = WorkspaceCheckpointLookupResultSchema.parse(
      await options.operations.lookupCheckpoint({
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
      }),
    );
    assert(
      checkpointLookup.status === "found" &&
        workspaceCheckpointResultMatchesRequest(
          checkpointRequest,
          checkpointLookup,
        ) &&
        deepEqual(checkpointLookup.checkpoint, createdCheckpoint.checkpoint),
      "checkpoint lookup must recover the remote result",
      checked,
    );
    checked.push("checkpoint-recovery");

    const changedCheckpointMaterial = {
      source: checkpointRequest.source,
      name: `${checkpointRequest.name ?? "checkpoint"}-changed`,
      metadata: checkpointRequest.metadata,
    };
    const checkpointConflict = WorkspaceCheckpointResultSchema.parse(
      await options.operations.checkpoint({
        ...changedCheckpointMaterial,
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: workspaceCheckpointRequestDigest(changedCheckpointMaterial),
      }),
    );
    assert(
      checkpointConflict.status === "conflict" &&
        checkpointConflict.existingRequestDigest === checkpointRequest.requestDigest,
      "changed checkpoint input must conflict with the original digest",
      checked,
    );
    checked.push("checkpoint-conflict");

    const forkRequest = options.forkRequest(createdCheckpoint.checkpoint);
    issuedForkRequest = forkRequest;
    const createdFork = WorkspaceForkResultSchema.parse(
      await options.operations.fork(forkRequest),
    );
    assert(
      createdFork.status === "created" &&
        workspaceForkResultMatchesRequest(forkRequest, createdFork),
      "environment fork must match the exact create request",
      checked,
    );
    forkRef = createdFork.environment;
    const replayedFork = WorkspaceForkResultSchema.parse(
      await options.operations.fork(forkRequest),
    );
    assert(
      replayedFork.status === "replayed" &&
        workspaceForkResultMatchesRequest(forkRequest, replayedFork) &&
        deepEqual(replayedFork.environment, createdFork.environment),
      "fork retry must return the original destination environment",
      checked,
    );
    checked.push("fork-retry");

    const forkLookup = WorkspaceForkLookupResultSchema.parse(
      await options.operations.lookupFork({
        idempotencyKey: forkRequest.idempotencyKey,
        requestDigest: forkRequest.requestDigest,
      }),
    );
    assert(
      forkLookup.status === "found" &&
        workspaceForkResultMatchesRequest(forkRequest, forkLookup) &&
        deepEqual(forkLookup.environment, createdFork.environment),
      "fork lookup must recover the destination environment",
      checked,
    );
    checked.push("fork-recovery");

    const changedForkMaterial = {
      checkpoint: forkRequest.checkpoint,
      name: `${forkRequest.name ?? "fork"}-changed`,
      metadata: forkRequest.metadata,
    };
    const forkConflict = WorkspaceForkResultSchema.parse(
      await options.operations.fork({
        ...changedForkMaterial,
        idempotencyKey: forkRequest.idempotencyKey,
        requestDigest: workspaceForkRequestDigest(changedForkMaterial),
      }),
    );
    assert(
      forkConflict.status === "conflict" &&
        forkConflict.existingRequestDigest === forkRequest.requestDigest,
      "changed fork input must conflict with the original digest",
      checked,
    );
    checked.push("fork-conflict");

    const checkpointCleanupRequest = {
      operationId: `${checkpointRequest.idempotencyKey}-cleanup`,
      targetId: createdCheckpoint.checkpoint.checkpointId,
      provider: createdCheckpoint.checkpoint.provider,
    };
    const inUseCheckpoint = WorkspaceCleanupAcknowledgementSchema.parse(
      await options.operations.deleteCheckpoint(checkpointCleanupRequest),
    );
    assert(
      inUseCheckpoint.status === "in_use" &&
        inUseCheckpoint.operationId === checkpointCleanupRequest.operationId &&
        inUseCheckpoint.targetId === checkpointCleanupRequest.targetId &&
        inUseCheckpoint.provider === checkpointCleanupRequest.provider &&
        inUseCheckpoint.blockingTargetIds?.includes(
          createdFork.environment.environmentId,
        ) === true &&
        !workspaceCleanupAcknowledgementMatches(
          checkpointCleanupRequest,
          inUseCheckpoint,
        ),
      "checkpoint cleanup must identify a dependent fork without deleting either resource",
      checked,
    );
    const checkpointAfterBlockedCleanup = WorkspaceCheckpointLookupResultSchema.parse(
      await options.operations.lookupCheckpoint({
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
      }),
    );
    const forkAfterBlockedCleanup = WorkspaceForkLookupResultSchema.parse(
      await options.operations.lookupFork({
        idempotencyKey: forkRequest.idempotencyKey,
        requestDigest: forkRequest.requestDigest,
      }),
    );
    assert(
      checkpointAfterBlockedCleanup.status === "found" &&
        forkAfterBlockedCleanup.status === "found",
      "blocked checkpoint cleanup must leave the checkpoint and fork recoverable",
      checked,
    );
    checked.push("cleanup-dependency-order");

    const forkCleanupRequest = {
      operationId: `${forkRequest.idempotencyKey}-cleanup`,
      targetId: createdFork.environment.environmentId,
      provider: createdFork.environment.provider,
    };
    const forkCleanup = WorkspaceCleanupAcknowledgementSchema.parse(
      await options.operations.destroyFork(forkCleanupRequest),
    );
    assert(
      forkCleanup.status === "deleted" &&
        workspaceCleanupAcknowledgementMatches(forkCleanupRequest, forkCleanup),
      "fork cleanup must be confirmed for the exact target",
      checked,
    );
    const repeatedForkCleanup = WorkspaceCleanupAcknowledgementSchema.parse(
      await options.operations.destroyFork(forkCleanupRequest),
    );
    assert(
      repeatedForkCleanup.status === "already_absent" &&
        workspaceCleanupAcknowledgementMatches(
          forkCleanupRequest,
          repeatedForkCleanup,
        ),
      "fork cleanup retry must confirm the target is absent",
      checked,
    );
    forkCleanupConfirmed = true;
    const checkpointCleanup = WorkspaceCleanupAcknowledgementSchema.parse(
      await options.operations.deleteCheckpoint(checkpointCleanupRequest),
    );
    assert(
      checkpointCleanup.status === "deleted" &&
        workspaceCleanupAcknowledgementMatches(
          checkpointCleanupRequest,
          checkpointCleanup,
        ),
      "checkpoint cleanup must be confirmed",
      checked,
    );
    const repeatedCheckpointCleanup = WorkspaceCleanupAcknowledgementSchema.parse(
      await options.operations.deleteCheckpoint(checkpointCleanupRequest),
    );
    assert(
      repeatedCheckpointCleanup.status === "already_absent" &&
        workspaceCleanupAcknowledgementMatches(
          checkpointCleanupRequest,
          repeatedCheckpointCleanup,
        ),
      "checkpoint cleanup retry must confirm the target is absent",
      checked,
    );
    checkpointCleanupConfirmed = true;
    checked.push("confirmed-cleanup");

    const missingCheckpoint = WorkspaceCheckpointLookupResultSchema.parse(
      await options.operations.lookupCheckpoint({
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
      }),
    );
    const missingFork = WorkspaceForkLookupResultSchema.parse(
      await options.operations.lookupFork({
        idempotencyKey: forkRequest.idempotencyKey,
        requestDigest: forkRequest.requestDigest,
      }),
    );
    assert(
      missingCheckpoint.status === "not_found" && missingFork.status === "not_found",
      "cleaned resources must not remain recoverable",
      checked,
    );
    checked.push("cleanup-lookup");

    return {
      name: options.name,
      checkpointId: createdCheckpoint.checkpoint.checkpointId,
      environmentId: createdFork.environment.environmentId,
      checked,
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupWorkspaceResources({
      operations: options.operations,
      checkpointRequest: checkpointCleanupConfirmed
        ? undefined
        : checkpointRequest,
      checkpointRef: checkpointCleanupConfirmed ? undefined : checkpointRef,
      forkRequest: forkCleanupConfirmed ? undefined : issuedForkRequest,
      forkRef: forkCleanupConfirmed ? undefined : forkRef,
    });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined
          ? cleanupErrors
          : [operationError, ...cleanupErrors],
        operationError === undefined
          ? "workspace conformance cleanup failed"
          : "workspace conformance and cleanup failed",
      );
    }
  }
}

async function cleanupWorkspaceResources(input: {
  operations: AgentWorkspaceBranching;
  checkpointRequest?: WorkspaceCheckpointRequest;
  checkpointRef?: WorkspaceCheckpointRef;
  forkRequest?: WorkspaceForkRequest;
  forkRef?: { environmentId: string; provider: string };
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (input.forkRequest) {
    try {
      const forkRef =
        input.forkRef ??
        (await recoverForkForCleanup(input.operations, input.forkRequest));
      if (forkRef !== undefined) {
        const request = {
          operationId: `${input.forkRequest.idempotencyKey}-cleanup`,
          targetId: forkRef.environmentId,
          provider: forkRef.provider,
        };
        const acknowledgement = WorkspaceCleanupAcknowledgementSchema.parse(
          await input.operations.destroyFork(request),
        );
        if (!workspaceCleanupAcknowledgementMatches(request, acknowledgement)) {
          throw new Error(
            "fork cleanup did not confirm the exact target is absent",
          );
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (input.checkpointRequest) {
    try {
      const checkpointRef =
        input.checkpointRef ??
        (await recoverCheckpointForCleanup(
          input.operations,
          input.checkpointRequest,
        ));
      if (checkpointRef !== undefined) {
        const request = {
          operationId: `${input.checkpointRequest.idempotencyKey}-cleanup`,
          targetId: checkpointRef.checkpointId,
          provider: checkpointRef.provider,
        };
        const acknowledgement = WorkspaceCleanupAcknowledgementSchema.parse(
          await input.operations.deleteCheckpoint(request),
        );
        if (!workspaceCleanupAcknowledgementMatches(request, acknowledgement)) {
          throw new Error(
            "checkpoint cleanup did not confirm the exact target is absent",
          );
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function recoverCheckpointForCleanup(
  operations: AgentWorkspaceBranching,
  request: WorkspaceCheckpointRequest,
): Promise<WorkspaceCheckpointRef | undefined> {
  const result = WorkspaceCheckpointLookupResultSchema.parse(
    await operations.lookupCheckpoint({
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
    }),
  );
  if (result.status === "not_found") return undefined;
  if (
    result.status !== "found" ||
    !workspaceCheckpointResultMatchesRequest(request, result)
  ) {
    throw new Error(
      "checkpoint cleanup could not recover the exact remote result",
    );
  }
  return result.checkpoint;
}

async function recoverForkForCleanup(
  operations: AgentWorkspaceBranching,
  request: WorkspaceForkRequest,
): Promise<{ environmentId: string; provider: string } | undefined> {
  const result = WorkspaceForkLookupResultSchema.parse(
    await operations.lookupFork({
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
    }),
  );
  if (result.status === "not_found") return undefined;
  if (
    result.status !== "found" ||
    !workspaceForkResultMatchesRequest(request, result)
  ) {
    throw new Error("fork cleanup could not recover the exact remote result");
  }
  return result.environment;
}

/** Check exact launch, output, recovery, lookup, and deletion behavior. */
export async function runAgentExactProcessProviderLifecycleChecks(
  options: ExactProcessProviderLifecycleOptions,
): Promise<ExactProcessProviderLifecycleReport> {
  const checked: string[] = [];
  const provider = await options.createProvider();
  const capabilities = AgentEnvironmentCapabilitiesSchema.parse(
    await provider.capabilities(),
  );
  assert(provider.exactProcess, "provider.exactProcess is required", checked);
  assert(capabilities.exactProcess, "capabilities.exactProcess is required", checked);
  assert(
    capabilities.exactProcess.egress.includes(options.createInput.egress.mode),
    `provider does not declare ${options.createInput.egress.mode} egress support`,
    checked,
  );
  checked.push("exact-process-capability");

  const operation = new AbortController();
  const timeout = setTimeout(
    () => operation.abort(new Error("exact process lifecycle check timed out")),
    options.timeoutMs ?? 30_000,
  );
  const signal = options.createInput.signal
    ? AbortSignal.any([options.createInput.signal, operation.signal])
    : operation.signal;
  let environment: AgentExactProcessEnvironment;
  try {
    environment = await abortable(
      provider.exactProcess.create({ ...options.createInput, signal }),
      signal,
    );
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  let destroyAttempted = false;
  try {
    const repeated = await abortable(
      provider.exactProcess.create({ ...options.createInput, signal }),
      signal,
    );
    assert(
      repeated.id === environment.id,
      "repeated exact create must recover the same environment",
      checked,
    );
    checked.push("exact-process-idempotency");

    let collisionRejected = false;
    let collisionEnvironment: AgentExactProcessEnvironment | undefined;
    try {
      collisionEnvironment = await abortable(
        provider.exactProcess.create({
          ...options.createInput,
          maxLifetimeMs: options.createInput.maxLifetimeMs + 1_000,
          signal,
        }),
        signal,
      );
    } catch {
      collisionRejected = true;
    } finally {
      if (
        collisionEnvironment?.id &&
        collisionEnvironment.id !== environment.id
      ) {
        await abortable(
          collisionEnvironment.destroy(),
          signal,
        );
      }
    }
    assert(
      collisionRejected,
      "reusing an exact idempotency key with different input must fail",
      checked,
    );
    checked.push("exact-process-idempotency-collision");

    assert((await environment.process.list()).length === 0, "exact environment must start empty", checked);
    checked.push("fresh-environment");

    const expectedFile = Uint8Array.of(0, 1, 2, 255);
    await environment.writeFile("/tmp/agent-provider-testkit.bin", expectedFile, {
      mode: 0o640,
      signal,
    });
    const actualFile = await environment.readFile(
      "/tmp/agent-provider-testkit.bin",
      { maxBytes: expectedFile.byteLength, signal },
    );
    assert(
      bytesEqual(actualFile, expectedFile),
      "exact file read must return the bytes that were written",
      checked,
    );
    let boundedReadRejected = false;
    try {
      await environment.readFile("/tmp/agent-provider-testkit.bin", {
        maxBytes: expectedFile.byteLength - 1,
        signal,
      });
    } catch {
      boundedReadRejected = true;
    }
    assert(
      boundedReadRejected,
      "exact file read must reject content above maxBytes",
      checked,
    );
    checked.push("exact-file-roundtrip");

    const process = await environment.process.spawn(options.launch, {
      signal,
    });
    assert(
      (await environment.process.list()).some((entry) => entry.pid === process.pid),
      "spawned exact process must appear in process.list()",
      checked,
    );
    const stdout = (await collect(process.stdout())).join("");
    const stderr = (await collect(process.stderr())).join("");
    const termination = await abortable(process.wait(), signal);
    const status = await process.status();
    assert(!status.running, "exact process must reach a terminal status", checked);
    assert(status.termination, "terminal exact process status requires a reason", checked);
    assert(
      terminationEqual(status.termination, termination),
      "wait() and status() termination reasons must match",
      checked,
    );
    assert(stdout === options.expectedStdout, "exact process stdout differs", checked);
    assert(stderr === options.expectedStderr, "exact process stderr differs", checked);
    await process.kill();
    checked.push("exact-process-run");

    const recovered = await provider.exactProcess.get(environment.id);
    assert(recovered, "exact environment must be recoverable by id", checked);
    const recoveredProcess = await recovered.process.get(process.pid);
    assert(recoveredProcess, "exact process must be recoverable by pid", checked);
    assert(
      (await collect(recoveredProcess.stdout())).join("") === options.expectedStdout,
      "recovered exact process stdout differs",
      checked,
    );
    assert(
      (await collect(recoveredProcess.stderr())).join("") === options.expectedStderr,
      "recovered exact process stderr differs",
      checked,
    );
    checked.push("exact-process-recovery");

    const listed = await provider.exactProcess.list({ metadata: options.createInput.metadata });
    assert(
      listed.filter((candidate) => candidate.id === environment.id).length === 1,
      "exact environment metadata lookup must return one matching id",
      checked,
    );
    checked.push("exact-process-list");

    destroyAttempted = true;
    await abortable(environment.destroy(), signal);
    assert(
      (await provider.exactProcess.get(environment.id)) === null,
      "destroyed exact environment must not be recoverable",
      checked,
    );
    assert(
      !(await provider.exactProcess.list({
        metadata: options.createInput.metadata,
      })).some((candidate) => candidate.id === environment.id),
      "destroyed exact environment must disappear from list()",
      checked,
    );
    checked.push("exact-process-destroy");

    return {
      provider: provider.name,
      environmentId: environment.id,
      pid: process.pid,
      checked,
    };
  } finally {
    clearTimeout(timeout);
    if (!destroyAttempted) await environment.destroy();
  }
}

async function checkWorkspace(
  environment: AgentEnvironment,
  capabilities: AgentEnvironmentCapabilities,
  checked: string[],
): Promise<void> {
  if (capabilities.workspace.write) {
    assert(typeof environment.write === "function", "workspace.write requires write()", checked);
    await environment.write?.("agent-provider-testkit.txt", "ok");
    checked.push("workspace-write");
  }

  if (capabilities.workspace.read) {
    assert(typeof environment.read === "function", "workspace.read requires read()", checked);
    await environment.read?.("agent-provider-testkit.txt");
    checked.push("workspace-read");
  }

  if (capabilities.workspace.exec) {
    assert(typeof environment.exec === "function", "workspace.exec requires exec()", checked);
    const result = await environment.exec?.("echo ok");
    assert(result?.exitCode !== undefined, "exec() must return an exit code", checked);
    checked.push("workspace-exec");
  }
}

function checkCapabilityExposure(
  environment: AgentEnvironment,
  capabilities: AgentEnvironmentCapabilities,
  checked: string[],
): void {
  const checkMethod = (
    method: keyof AgentEnvironment,
    enabled: boolean,
    capability: string,
  ) => {
    assert(
      (typeof environment[method] === "function") === enabled,
      enabled
        ? `${capability} requires ${String(method)}()`
        : `${capability} is disabled but ${String(method)}() is exposed`,
      checked,
    );
  };

  checkMethod("dispatch", capabilities.streaming.detach, "streaming.detach");
  checkMethod(
    "session",
    capabilities.streaming.detach ||
      capabilities.streaming.replay ||
      capabilities.sessions.continue,
    "session control",
  );
  checkMethod(
    "respondToInteraction",
    capabilities.interactions !== undefined,
    "interactions",
  );
  checkMethod("read", capabilities.workspace.read, "workspace.read");
  checkMethod("write", capabilities.workspace.write, "workspace.write");
  checkMethod("exec", capabilities.workspace.exec, "workspace.exec");
  checkMethod(
    "checkpoint",
    capabilities.branching.checkpoint,
    "branching.checkpoint",
  );
  checkMethod("fork", capabilities.branching.fork, "branching.fork");
  checkMethod("placement", capabilities.placement, "placement");

  const durableBranching =
    capabilities.branching.retrySafe === true &&
    capabilities.branching.lookup === true &&
    capabilities.branching.cleanup === true;
  assert(
    (environment.workspaceBranching !== undefined) === durableBranching,
    durableBranching
      ? "durable branching requires workspaceBranching operations"
      : "durable branching is disabled but workspaceBranching is exposed",
    checked,
  );
  checked.push("capability-exposure");
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

function assertNoContextEffects(
  before: PortableContextConformanceCounters,
  after: PortableContextConformanceCounters,
  checked: string[],
): void {
  assert(
    after.transfers === before.transfers &&
      after.freshSessions === before.freshSessions &&
      after.nativeContinuations === before.nativeContinuations,
    "context planning or rejection must dispatch no run or session",
    checked,
  );
}

function assertPortablePlanCoversRequest(
  request: PortableContextPlanRequest,
  result: Extract<PortableContextPlanResult, { status: "ready" }>,
  checked: string[],
): void {
  assert(
    deepEqual(result.plan.source, request.source),
    "context plan source differs from the requested context",
    checked,
  );
  assert(
    deepEqual(result.plan.destination, request.destination),
    "context plan destination differs from the request",
    checked,
  );
  const sourceMessages = [...request.source.messages].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const decisions = [...result.plan.messages].sort((left, right) =>
    left.messageId.localeCompare(right.messageId),
  );
  assert(
    sourceMessages.length === decisions.length,
    "context plan must decide every source message",
    checked,
  );
  for (let index = 0; index < sourceMessages.length; index++) {
    const message = sourceMessages[index];
    const decision = decisions[index];
    assert(
      message?.id === decision?.messageId,
      "context plan message ids differ from the source",
      checked,
    );
    const partIndexes = decision?.parts
      .map((part) => part.partIndex)
      .sort((left, right) => left - right);
    assert(
      deepEqual(
        partIndexes,
        message?.parts.map((_, partIndex) => partIndex),
      ),
      `context plan must decide every part of message ${message?.id ?? "unknown"}`,
      checked,
    );
  }
}

function differentBoundary(boundary: NativeContextBoundary): NativeContextBoundary {
  switch (boundary.kind) {
    case "token":
      return { kind: "token", token: `${boundary.token}-different` };
    case "revision":
      return { kind: "revision", revision: `${boundary.revision}-different` };
    case "digest":
      return {
        kind: "digest",
        digest:
          boundary.digest === `sha256:${"0".repeat(64)}`
            ? `sha256:${"1".repeat(64)}`
            : `sha256:${"0".repeat(64)}`,
      };
    case "messages":
      return {
        ...boundary,
        digest:
          boundary.digest === `sha256:${"0".repeat(64)}`
            ? `sha256:${"1".repeat(64)}`
            : `sha256:${"0".repeat(64)}`,
      };
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

async function withEnvironmentCleanup<T>(
  environment: AgentEnvironment,
  checked: string[],
  operation: () => Promise<T>,
  recordCleanup = false,
): Promise<T> {
  let outcome:
    | { ok: true; value: T }
    | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanupError: unknown;
  try {
    await environment.destroy?.();
    if (outcome.ok && recordCleanup) checked.push("destroy");
  } catch (error) {
    cleanupError = error;
  }

  if (!outcome.ok) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        "provider conformance and environment cleanup failed",
      );
    }
    throw outcome.error;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return outcome.value;
}

function assert(value: unknown, message: string, checked: string[]): asserts value {
  if (!value) throw new ProviderConformanceError(message, checked);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function terminationEqual(
  left: AgentCandidateTermination,
  right: AgentCandidateTermination,
): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "exit":
      return a.exitCode === b.exitCode;
    case "timeout":
      return a.timeoutMs === b.timeoutMs;
    case "signal":
      return a.signal === b.signal;
    case "cancelled":
      return true;
    default:
      return false;
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("operation aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isTerminalEvent(event: AgentEnvironmentEvent): boolean {
  if (event.type === "result" || event.type === "done" || event.type === "final") return true;
  if (event.type.endsWith(".completed") || event.type.endsWith(".failed")) return true;
  if (event.type === "status") {
    return event.data.status === "completed" || event.data.status === "failed" || event.data.status === "cancelled";
  }
  return false;
}
