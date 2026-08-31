import { describe, expect, it } from "vitest";
import type {
  AgentExactProcessLaunch,
} from "./environment-exact-process.js";
import {
  AgentEnvironmentCapabilitiesSchema,
  AgentNativeContextContinuationResultSchema,
  AgentTurnInputSchema,
  AgentTurnResultSchema,
  agentNativeContextContinuationResultMatchesRequest,
} from "./environment-runtime.js";
import { AgentProfileCapabilitiesSchema } from "./environment-profile-capabilities.js";
import type { AgentEnvironmentQuery, PlacementInfo } from "./environment-requests.js";
import {
  InteractionRequestSchema,
  InteractionResponseCommandSchema,
  InteractionSecretReferenceSchema,
  interactionResponseCommandDigest,
  interactionRequestDigest,
  type InteractionRequestMaterial,
} from "./interaction-envelope.js";
import {
  InteractionAnswerSpecSchema,
  InteractionFieldNameSchema,
  InteractionFieldSchema,
} from "./interaction-fields.js";
import { permissionAnswerSpec } from "./interaction-permissions.js";
import { validateInteractionAnswer } from "./interaction-answer-validation.js";
import { validateResolutionForRequest } from "./interaction-resolution-validation.js";
import {
  validateAndParseInteractionResponse,
  validateInteractionResponse,
  validateInteractionResponseCommand,
} from "./interaction-response-validation.js";
import {
  PortableConversationContextSchema,
  portableConversationContextDigest,
  type PortableConversationContext,
} from "./portable-context-base.js";
import {
  NativeContextBoundaryProofSchema,
  NativeContextContinuationAcknowledgementSchema,
  NativeContextContinuationRequestSchema,
  nativeContextContinuationAcknowledgementMatches,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
} from "./portable-context-continuation.js";
import {
  PortableContextPlanResultSchema,
  PortableContextPlanRequestSchema,
  portableContextPlanRequestDigest,
  portableContextPlanResultMatchesRequest,
} from "./portable-context-plan-request.js";
import {
  PortableContextPlanSchema,
  portableContextPlanDigest,
  type PortableContextPlan,
} from "./portable-context-plan.js";
import {
  BackendMessageSchema,
  InputPartSchema,
  wireDigest as portableWireDigest,
} from "./portable-context-shared.js";
import { isBoundedJsonValue } from "./contract-limits.js";
import {
  ContextTransferReceiptSchema,
  ContextTransferRequestSchema,
  contextTransferReceiptMatches,
  contextTransferRequestDigest,
  type ContextTransferReceipt,
} from "./portable-context-transfer.js";
import {
  CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH,
  CONTRACT_MAX_JSON_BYTES,
  CONTRACT_MAX_STRING_LENGTH,
  boundedJsonSchema,
  boundedStringSchema,
  nullPrototypeRecord,
} from "./contract-limits.js";
import {
  WorkspaceCheckpointRefSchema,
  WorkspaceCheckpointRequestSchema,
  workspaceCheckpointRequestDigest,
  workspaceCheckpointResultMatchesRequest,
} from "./workspace-checkpoint.js";
import {
  WorkspaceCleanupAcknowledgementSchema,
  WorkspaceCleanupRequestSchema,
  workspaceCleanupAcknowledgementMatches,
  workspaceCleanupRequestDigest,
} from "./workspace-cleanup.js";
import {
  ConfidentialAttestationSchema,
  ConfidentialExecutionRequestSchema,
  confidentialExecutionRequestDigest,
  confidentialExecutionVerified,
} from "./workspace-confidentiality.js";
import {
  ForkedEnvironmentRefSchema,
  WorkspaceForkRequestSchema,
  forkedEnvironmentConfidentialityVerified,
  workspaceForkRequestDigest,
  workspaceForkResultMatchesRequest,
} from "./workspace-fork.js";
import { wireDigest as workspaceWireDigest } from "./workspace-branching-shared.js";
import {
  AgentEnvironmentObservationSchema,
  SafeEndpointSchema,
  observationContainsCredential,
} from "./environment-observation.js";
import {
  TerminalAttachResultSchema,
  TerminalSessionRefSchema,
  terminalSessionUsable,
} from "./environment-terminal.js";
import {
  canonicalWorkspaceCwd,
  workspaceCwdPathForBase,
  workspaceCwdSchema,
} from "./workspace-cwd.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as `sha256:${string}`;

const exactRun = {
  runId: "run-source",
  provider: "provider-a",
  environmentId: "environment-source",
  sessionId: "session-source",
  executionId: "execution-source",
  requestDigest: digest("a"),
};

const sourceMaterial = {
  source: { ...exactRun, messageId: "message-1" },
  completeness: "complete" as const,
  messages: [
    {
      id: "message-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "keep this context" }],
      timestamp: "2026-08-01T20:00:00.000Z",
    },
  ],
  attachments: [],
};

const source: PortableConversationContext = {
  ...sourceMaterial,
  digest: portableConversationContextDigest(sourceMaterial),
};

const destination = {
  runner: "runner-b",
  provider: "provider-b",
  environmentId: "environment-destination",
  sessionId: "session-destination",
  runId: "run-destination",
  executionId: "execution-destination",
  profileDigest: digest("b"),
};

function makePlan(): PortableContextPlan {
  const material = {
    planId: "plan-1",
    source,
    destination,
    messages: [
      {
        messageId: "message-1",
        action: "include" as const,
        parts: [{ partIndex: 0, action: "include" as const }],
      },
    ],
    context: source,
    estimatedTokens: 8,
    requiresAcceptance: false,
  };
  return { ...material, digest: portableContextPlanDigest(material) };
}

function makeInteraction() {
  const material: InteractionRequestMaterial = {
    id: "interaction-1",
    kind: "question",
    title: "Provide credentials",
    answerSpec: {
      fields: [
        { type: "secret", name: "token", label: "Token", required: true },
        { type: "text", name: "note", label: "Note" },
      ],
    },
    binding: {
      runId: exactRun.runId,
      provider: exactRun.provider,
      environmentId: exactRun.environmentId,
      sessionId: exactRun.sessionId,
      executionId: exactRun.executionId,
      interactionId: "interaction-1",
    },
  };
  return InteractionRequestSchema.parse({
    ...material,
    requestDigest: interactionRequestDigest(material),
  });
}

describe("interface split leaf modules", () => {
  it("bounds shared JSON and preserves safe arbitrary-key maps", () => {
    expect(boundedStringSchema.safeParse("x".repeat(CONTRACT_MAX_STRING_LENGTH + 1)).success).toBe(false);
    expect(boundedJsonSchema.safeParse({ nested: ["ok"] }).success).toBe(true);
    const shared = { value: "same" };
    expect(isBoundedJsonValue({ left: shared, right: shared })).toBe(true);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isBoundedJsonValue(cycle)).toBe(false);
    const safe = nullPrototypeRecord({ constructor: "data" });
    expect(Object.getPrototypeOf(safe)).toBeNull();
    expect(safe.constructor).toBe("data");
    expect(portableWireDigest({ safe })).toMatch(/^sha256:/);
    expect(workspaceWireDigest({ safe })).toMatch(/^sha256:/);
    expect(workspaceWireDigest({ optional: undefined })).toBe(
      workspaceWireDigest({}),
    );
    const unicodeMaterial = Array.from({ length: 1_020 }, () => "é".repeat(1_024));
    expect(JSON.stringify(unicodeMaterial)!.length).toBeLessThan(
      CONTRACT_MAX_JSON_BYTES,
    );
    expect(() => portableWireDigest(unicodeMaterial)).toThrow(/byte bound/);
  });

  it("exports the portable workspace cwd leaf contract", () => {
    expect(canonicalWorkspaceCwd({ base: "repository", path: "./packages//braid/." })).toEqual({
      base: "repository",
      path: "packages/braid",
    });
    expect(workspaceCwdSchema.safeParse("/workspace/src").success).toBe(false);
    expect(workspaceCwdPathForBase(
      { base: "repository", path: "packages/agent-interface" },
      "repository",
      "test",
    )).toBe("packages/agent-interface");
    expect(() => workspaceCwdPathForBase(
      { base: "host", path: "/workspace" },
      "repository",
      "test",
    )).toThrow('test supports workspace cwd base "repository", not "host"');
  });

  it("directly validates profile, environment, and process leaf contracts", () => {
    expect(
      AgentProfileCapabilitiesSchema.parse({
        namedProfiles: true,
        systemPrompt: { replace: true, append: true },
        instructions: true,
        tools: true,
        permissions: true,
        mcp: false,
        subagents: false,
        resources: { files: true, instructions: true },
        runtimeUpdate: false,
        validation: true,
        extensions: ["x.profile"],
      }),
    ).toMatchObject({ extensions: ["x.profile"] });
    expect(() =>
      AgentProfileCapabilitiesSchema.parse({
        namedProfiles: true,
        systemPrompt: { replace: true, append: true },
        instructions: true,
        tools: true,
        permissions: true,
        mcp: false,
        subagents: false,
        resources: { files: true, instructions: true },
        runtimeUpdate: false,
        validation: true,
        extensions: ["x".repeat(513)],
      }),
    ).toThrow();
    const launch: AgentExactProcessLaunch = {
      executable: "/bin/echo",
      args: ["ok"],
      cwd: "/tmp",
      env: Object.create(null) as Record<string, string>,
      timeoutMs: 1000,
    };
    const query: AgentEnvironmentQuery = { name: "worker", metadata: { owner: "test" } };
    const placement: PlacementInfo = { kind: "sandbox", sandboxId: "environment-destination" };
    expect(launch.executable).toBe("/bin/echo");
    expect(query.metadata).toEqual({ owner: "test" });
    expect(placement.kind).toBe("sandbox");
  });

  it("rejects prototype field names and keeps accepted secrets for direct provider delivery", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(InteractionFieldNameSchema.safeParse(name).success).toBe(false);
      expect(() =>
        InteractionFieldSchema.parse({ type: "text", name, label: "bad" }),
      ).toThrow();
    }
    const interaction = makeInteraction();
    expect(InteractionAnswerSpecSchema.parse(interaction.answerSpec)).toEqual(interaction.answerSpec);
    expect(permissionAnswerSpec({ responseScopes: ["interaction"] }).fields).toHaveLength(2);
    expect(validateInteractionAnswer(interaction.answerSpec, { token: "raw", note: "ok" })).toEqual({ ok: true });
    expect(validateResolutionForRequest(interaction, { outcome: "declined", data: { token: "raw" } })).toEqual([
      'field "token" is secret and cannot ride a declined resolution',
      "a declined resolution cannot carry answer fields",
    ]);
    const parsed = validateAndParseInteractionResponse(interaction, {
      id: interaction.id,
      outcome: "accepted",
      data: { token: "seeded-secret", note: "ok" },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.response.data?.token).toBe("seeded-secret");
      expect(JSON.stringify(parsed)).toContain("seeded-secret");
    }
    const verdict = validateInteractionResponse(interaction, {
      id: interaction.id,
      outcome: "accepted",
      data: { token: "seeded-secret", note: "ok" },
    });
    expect(verdict.ok).toBe(true);
    expect(JSON.stringify(verdict)).not.toContain("seeded-secret");
    expect(InteractionSecretReferenceSchema.parse({
      kind: "secret_handle",
      handleId: "credential-1",
      oneUse: true,
    })).toMatchObject({ oneUse: true });
    const stale = validateAndParseInteractionResponse(interaction, {
      id: "stale-interaction",
      outcome: "accepted",
      data: { token: "secret" },
    });
    expect(stale.ok).toBe(false);
    const commandMaterial = {
      operationId: "response-operation",
      binding: {
        ...interaction.binding,
        requestDigest: interaction.requestDigest,
      },
      response: { id: interaction.id, outcome: "accepted" as const, data: { token: "secret" } },
    };
    const command = {
      ...commandMaterial,
      commandDigest: interactionResponseCommandDigest(commandMaterial),
    };
    expect(InteractionResponseCommandSchema.parse(command)).toEqual(command);
    expect(validateInteractionResponseCommand(interaction, command).ok).toBe(true);
    expect(validateInteractionResponseCommand(interaction, {
      ...command,
      binding: { ...command.binding, executionId: "other-execution" },
    }).ok).toBe(false);
  });

  it("binds portable planning, transfer, and chronology to exact identities", () => {
    expect(PortableConversationContextSchema.parse(source)).toEqual(source);
    expect(BackendMessageSchema.parse(source.messages[0])).toEqual(source.messages[0]);
    expect(InputPartSchema.parse(source.messages[0]!.parts[0])).toEqual(source.messages[0]!.parts[0]);
    const plan = makePlan();
    expect(PortableContextPlanSchema.parse(plan)).toEqual(plan);
    const requestMaterial = {
      requestId: "plan-request-1",
      source,
      destination,
      maxInputTokens: 100,
    };
    const planRequest = PortableContextPlanRequestSchema.parse({
      ...requestMaterial,
      requestDigest: portableContextPlanRequestDigest(requestMaterial),
    });
    expect(portableContextPlanResultMatchesRequest(planRequest, {
      status: "ready",
      requestId: planRequest.requestId,
      requestDigest: planRequest.requestDigest,
      plan,
    })).toBe(true);
    expect(PortableContextPlanResultSchema.parse({
      status: "over_limit",
      requestId: planRequest.requestId,
      requestDigest: planRequest.requestDigest,
      maxInputTokens: 100,
      estimatedTokens: 101,
      message: "too large",
    })).toMatchObject({ status: "over_limit" });
    const transferMaterial = {
      operationId: "transfer-1",
      plan,
      acceptance: {
        planDigest: plan.digest,
        acceptedAt: "2026-08-01T20:01:00.000Z",
        acceptedBy: "user" as const,
      },
    };
    const transfer = ContextTransferRequestSchema.parse({
      ...transferMaterial,
      requestDigest: contextTransferRequestDigest(transferMaterial),
    });
    const receipt: ContextTransferReceipt = {
      status: "accepted",
      operationId: transfer.operationId,
      requestDigest: transfer.requestDigest,
      planDigest: plan.digest,
      contextDigest: plan.context.digest,
      source: source.source,
      destination,
      provider: destination.provider,
      environmentId: destination.environmentId,
      sessionId: destination.sessionId,
      runId: destination.runId,
      executionId: destination.executionId,
      sessionCreatedForOperationId: transfer.operationId,
      sessionCreatedAt: "2026-08-01T20:01:00.500Z",
      transferredMessageIds: ["message-1"],
      omittedMessageIds: [],
      admittedAt: "2026-08-01T20:01:01.000Z",
    };
    expect(ContextTransferReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(contextTransferReceiptMatches(transfer, receipt)).toBe(true);
    for (const mutation of [
      { environmentId: source.source.environmentId },
      { sessionId: source.source.sessionId },
      { runId: source.source.runId },
      { executionId: source.source.executionId },
      { admittedAt: "2026-08-01T20:00:59.000Z" },
    ]) {
      expect(contextTransferReceiptMatches(transfer, { ...receipt, ...mutation })).toBe(false);
    }
    expect(() =>
      ContextTransferReceiptSchema.parse({ ...receipt, transferredMessageIds: ["message-1", "message-1"] }),
    ).toThrow();
  });

  it("requires the complete native continuation boundary and exact current run", () => {
    const proof = {
      ...exactRun,
      boundary: { kind: "messages" as const, messageIds: ["message-1"], digest: digest("c") },
      observedAt: "2026-08-01T20:00:00.000Z",
    };
    const turn = { prompt: "continue" };
    const material = {
      operationId: "continuation-1",
      turnDigest: nativeContextContinuationTurnDigest(turn),
      run: exactRun,
      expectedBoundary: proof,
    };
    const request = NativeContextContinuationRequestSchema.parse({
      ...material,
      requestDigest: nativeContextContinuationRequestDigest(material),
    });
    expect(NativeContextBoundaryProofSchema.parse(proof)).toEqual(proof);
    const acknowledgement = NativeContextContinuationAcknowledgementSchema.parse({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      status: "accepted",
      historyMessagesSent: 0,
      actualBoundary: proof,
    });
    expect(nativeContextContinuationAcknowledgementMatches(request, acknowledgement)).toBe(true);
    expect(nativeContextContinuationAcknowledgementMatches(request, {
      ...acknowledgement,
      actualBoundary: { ...proof, executionId: "other-execution" },
    })).toBe(false);
    const nativeOutcome = AgentNativeContextContinuationResultSchema.parse({
      acknowledgement,
      result: { text: "continued", success: true, sessionId: exactRun.sessionId },
      controlRef: exactRun,
    });
    expect(agentNativeContextContinuationResultMatchesRequest(request, nativeOutcome)).toBe(true);
    const advancedNativeOutcome = AgentNativeContextContinuationResultSchema.parse({
      acknowledgement,
      result: { text: "continued", success: true },
      controlRef: { ...exactRun, requestDigest: digest("d") },
    });
    expect(agentNativeContextContinuationResultMatchesRequest(request, advancedNativeOutcome)).toBe(true);
    const wrongNativeOutcome = AgentNativeContextContinuationResultSchema.parse({
      ...advancedNativeOutcome,
      controlRef: {
        ...exactRun,
        provider: "wrong-provider",
        requestDigest: digest("d"),
      },
    });
    expect(agentNativeContextContinuationResultMatchesRequest(request, wrongNativeOutcome)).toBe(false);
    expect(() =>
      AgentTurnInputSchema.parse({ prompt: "x", context: { huge: "x".repeat(CONTRACT_MAX_STRING_LENGTH + 1) } }),
    ).toThrow();
    expect(() =>
      AgentTurnResultSchema.parse({ text: "x", success: true, events: new Array(1_025).fill({}) }),
    ).toThrow();
    expect(AgentEnvironmentCapabilitiesSchema.parse({
      profile: {
        namedProfiles: true,
        systemPrompt: { replace: true, append: true },
        instructions: true,
        tools: true,
        permissions: true,
        mcp: false,
        subagents: false,
        resources: { files: true, instructions: true },
        runtimeUpdate: false,
        validation: true,
      },
      streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
      sessions: { continue: true, list: false, messages: false },
      workspace: { read: true, write: true, exec: true, git: false, upload: true, download: true },
      branching: { checkpoint: false, fork: false },
      placement: true,
      usage: false,
      confidential: false,
    })).toMatchObject({ placement: true });
  });

  it("validates the observation and interactive-terminal leaf contracts", () => {
    const observation = AgentEnvironmentObservationSchema.parse({
      subject: { provider: "provider-a", environmentId: "environment-source" },
      capturedAt: "2026-08-01T20:00:00.000Z",
      endpoint: {
        state: "known",
        value: { scheme: "https", host: "environment-source.example.com", port: 8080 },
        provenance: { origin: "measured", observedAt: "2026-08-01T20:00:00.000Z" },
      },
      computeBilling: { state: "unavailable", reason: "provider does not report cost" },
    });
    expect(observation.subject.provider).toBe("provider-a");
    expect(observationContainsCredential(observation)).toBe(false);
    expect(SafeEndpointSchema.safeParse({ host: "user:pass@host" }).success).toBe(false);
    const ref = TerminalSessionRefSchema.parse({
      terminalSessionId: "terminal-1",
      parentExecutionId: "execution-source",
      name: "shell",
      shell: "/bin/bash",
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      createdAt: "2026-08-01T20:00:00.000Z",
      lastActivityAt: "2026-08-01T20:00:00.000Z",
      expiresAt: "2026-08-01T21:00:00.000Z",
      isRunning: true,
      attachCount: 0,
    });
    expect(terminalSessionUsable(ref, "2026-08-01T20:30:00.000Z")).toBe(true);
    expect(TerminalSessionRefSchema.safeParse({ ...ref, pid: 42 }).success).toBe(false);
    expect(
      TerminalAttachResultSchema.parse({
        status: "attached",
        mode: "attach",
        ref,
        attachCount: 1,
      }).status,
    ).toBe("attached");
  });

  it("binds checkpoint, fork, cleanup, and provider attestation exactly", () => {
    const checkpointMaterial = { source: exactRun, name: "boundary", metadata: { owner: "test" } };
    const checkpointRequest = WorkspaceCheckpointRequestSchema.parse({
      ...checkpointMaterial,
      idempotencyKey: "checkpoint-operation",
      requestDigest: workspaceCheckpointRequestDigest(checkpointMaterial),
    });
    const checkpoint = WorkspaceCheckpointRefSchema.parse({
      checkpointId: "checkpoint-1",
      provider: exactRun.provider,
      source: exactRun,
      idempotencyKey: checkpointRequest.idempotencyKey,
      requestDigest: checkpointRequest.requestDigest,
      createdAt: "2026-08-01T20:00:00.000Z",
      metadata: checkpointMaterial.metadata,
    });
    const checkpointResult = {
      status: "created" as const,
      idempotencyKey: checkpointRequest.idempotencyKey,
      requestDigest: checkpointRequest.requestDigest,
      checkpoint,
    };
    expect(workspaceCheckpointResultMatchesRequest(checkpointRequest, checkpointResult)).toBe(true);
    expect(workspaceCheckpointResultMatchesRequest(checkpointRequest, {
      ...checkpointResult,
      checkpoint: { ...checkpoint, source: { ...exactRun, environmentId: "other-environment" } },
    })).toBe(false);
    const placement = { kind: "sandbox" as const, sandboxId: "environment-destination" };
    const confidential = {
      requested: true as const,
      nonce: "nonce-1",
      policy: "policy-1",
      profileDigest: digest("e"),
    };
    const forkMaterial = { checkpoint, placement, metadata: { owner: "test" }, confidential };
    const forkRequest = WorkspaceForkRequestSchema.parse({
      ...forkMaterial,
      idempotencyKey: "fork-operation",
      requestDigest: workspaceForkRequestDigest(forkMaterial),
    });
    const environment = ForkedEnvironmentRefSchema.parse({
      provider: exactRun.provider,
      environmentId: "environment-destination",
      sourceEnvironmentId: exactRun.environmentId,
      source: exactRun,
      sourceCheckpointId: checkpoint.checkpointId,
      idempotencyKey: forkRequest.idempotencyKey,
      requestDigest: forkRequest.requestDigest,
      createdAt: "2026-08-01T20:02:00.000Z",
      placement,
      confidentialRequested: true,
      metadata: forkMaterial.metadata,
    });
    const forkResult = {
      status: "created" as const,
      idempotencyKey: forkRequest.idempotencyKey,
      requestDigest: forkRequest.requestDigest,
      environment,
    };
    expect(workspaceForkResultMatchesRequest(forkRequest, forkResult)).toBe(true);
    expect(workspaceForkResultMatchesRequest(forkRequest, {
      ...forkResult,
      environment: { ...environment, sourceEnvironmentId: "wrong-source" },
    })).toBe(false);
    const cleanup = WorkspaceCleanupRequestSchema.parse({
      operationId: "cleanup-1",
      kind: "fork",
      targetId: environment.environmentId,
      provider: exactRun.provider,
      requestDigest: workspaceCleanupRequestDigest({
        kind: "fork",
        targetId: environment.environmentId,
        provider: exactRun.provider,
      }),
    });
    const cleanupAck = WorkspaceCleanupAcknowledgementSchema.parse({
      ...cleanup,
      status: "deleted",
    });
    expect(workspaceCleanupAcknowledgementMatches(cleanup, cleanupAck)).toBe(true);
    expect(workspaceCleanupAcknowledgementMatches(cleanup, { ...cleanupAck, targetId: "other" })).toBe(false);
    const confidentialityRequest = ConfidentialExecutionRequestSchema.parse(confidential);
    const environmentDigest = confidentialExecutionRequestDigest(confidentialityRequest);
    const attestation = ConfidentialAttestationSchema.parse({
      provider: exactRun.provider,
      requested: true,
      nonce: confidential.nonce,
      measurement: digest("f"),
      environmentId: environment.environmentId,
      source: exactRun,
      requestDigest: environmentDigest,
      profileDigest: confidential.profileDigest,
      policy: confidential.policy,
      quote: "provider-quote",
      providerKeyId: "provider-key",
      providerSignature: "signed-provider-quote",
      verifiedAt: "2026-08-01T20:02:01.000Z",
    });
    expect(
      ConfidentialAttestationSchema.safeParse({
        ...attestation,
        quote: "x".repeat(CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      ConfidentialAttestationSchema.safeParse({
        ...attestation,
        quote: "x".repeat(
          CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH + 1,
        ),
      }).success,
    ).toBe(false);
    expect(confidentialExecutionVerified({
      request: confidentialityRequest,
      environment: {
        provider: exactRun.provider,
        environmentId: environment.environmentId,
        source: exactRun,
        requestDigest: environmentDigest,
        confidentialRequested: true,
      },
      attestation,
      verifyProviderAttestation: () => true,
    })).toBe(true);
    expect(confidentialExecutionVerified({
      request: confidentialityRequest,
      environment: {
        provider: exactRun.provider,
        environmentId: environment.environmentId,
        source: exactRun,
        requestDigest: environmentDigest,
        confidentialRequested: true,
      },
      attestation,
    })).toBe(false);
    expect(forkedEnvironmentConfidentialityVerified(forkRequest, environment)).toBe(false);
  });
});
