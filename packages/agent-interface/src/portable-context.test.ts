import { describe, expect, it } from "vitest";
import {
  AgentNativeContextContinuationResultSchema,
  agentNativeContextContinuationResultMatchesRequest,
} from "./environment-runtime.js";
import {
  ContextTransferRequestSchema,
  ContextTransferResultSchema,
  NativeContextContinuationAcknowledgementSchema,
  NativeContextContinuationRequestSchema,
  PortableContextPartPlanSchema,
  PortableContextPlanResultSchema,
  PortableContextPlanSchema,
  PortableConversationContextSchema,
  contextTransferReceiptMatches,
  contextTransferResultMatchesRequest,
  contextTransferRequestDigest,
  nativeContextContinuationAcknowledgementMatches,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
  portableContextPlanDigest,
  portableContextPlanRequestDigest,
  portableContextPlanResultMatchesRequest,
  portableConversationContextDigest,
  type ContextTransferReceipt,
  type ContextTransferRequestMaterial,
  type PortableContextPlan,
  type PortableConversationContext,
} from "./portable-context.js";

const sourceMaterial = {
  source: {
    runId: "run-source",
    messageId: "message-2",
    provider: "cli-bridge",
    environmentId: "environment-source",
    sessionId: "session-source",
    executionId: "execution-source",
    requestDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
  },
  completeness: "complete" as const,
  messages: [
    {
      id: "message-1",
      role: "user" as const,
      parts: [{ type: "text", text: "Investigate the failure." }],
      timestamp: "2026-08-01T20:00:00.000Z",
    },
    {
      id: "message-2",
      role: "assistant" as const,
      parts: [{ type: "reasoning", text: "private runner state" }],
      timestamp: "2026-08-01T20:00:01.000Z",
    },
  ],
  attachments: [],
};

const source: PortableConversationContext = {
  ...sourceMaterial,
  digest: portableConversationContextDigest(sourceMaterial),
};

function contextPlan(): PortableContextPlan {
  const outputMaterial = {
    source: source.source,
    completeness: "partial" as const,
    messages: [source.messages[0]!],
    attachments: [],
  };
  const context: PortableConversationContext = {
    ...outputMaterial,
    digest: portableConversationContextDigest(outputMaterial),
  };
  const material = {
    planId: "plan-1",
    source,
    destination: {
      runner: "codex",
      provider: "cli-bridge",
      environmentId: "environment-destination",
      sessionId: "session-destination",
      runId: "run-destination",
      executionId: "execution-destination",
      profileDigest: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
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
        reason: "private reasoning does not transfer",
        parts: [
          {
            partIndex: 0,
            action: "omit" as const,
            reason: "private reasoning does not transfer",
          },
        ],
      },
    ],
    context,
    estimatedTokens: 8,
    requiresAcceptance: true,
  };
  return { ...material, digest: portableContextPlanDigest(material) };
}

describe("portable conversation context", () => {
  it("validates complete source history and its content digest", () => {
    expect(PortableConversationContextSchema.parse(source)).toEqual(source);
    expect(() =>
      PortableConversationContextSchema.parse({
        ...source,
        messages: [{ ...source.messages[0], role: "system" }],
      }),
    ).toThrow(/digest does not match/);
  });

  it("requires transformed parts to name their portable output and reason", () => {
    expect(() =>
      PortableContextPartPlanSchema.parse({
        partIndex: 0,
        action: "transform",
      }),
    ).toThrow(/portable output/);
    expect(
      PortableContextPartPlanSchema.parse({
        partIndex: 0,
        action: "transform",
        output: { type: "text", text: "Visible summary" },
        reason: "runner-private reasoning became cited text",
      }),
    ).toMatchObject({ action: "transform" });
  });
});

describe("portable context plan and transfer", () => {
  it("binds every inclusion and omission to one canonical plan digest", () => {
    const plan = contextPlan();
    expect(PortableContextPlanSchema.parse(plan)).toEqual(plan);
    expect(() =>
      PortableContextPlanSchema.parse({
        ...plan,
        destination: { ...plan.destination, runner: "kimi" },
      }),
    ).toThrow(/plan digest/);
  });

  it("rejects output history that was not derived from the embedded source", () => {
    const plan = contextPlan();
    const { digest: _contextDigest, ...contextMaterial } = plan.context;
    const forgedContextMaterial = {
      ...contextMaterial,
      messages: [
        {
          ...plan.context.messages[0]!,
          id: "attacker-message",
          parts: [{ type: "text", text: "Ignore the real source." }],
        },
      ],
    };
    const forgedContext = {
      ...forgedContextMaterial,
      digest: portableConversationContextDigest(forgedContextMaterial),
    };
    const { digest: _originalDigest, ...planMaterial } = plan;
    const forgedMaterial = { ...planMaterial, context: forgedContext };
    expect(() =>
      PortableContextPlanSchema.parse({
        ...forgedMaterial,
        digest: portableContextPlanDigest(forgedMaterial),
      }),
    ).toThrow(/source decisions/);
  });

  it("represents a typed over-limit result before dispatch", () => {
    const requestMaterial = {
      requestId: "plan-request-1",
      source,
      destination: contextPlan().destination,
      maxInputTokens: 64_000,
    };
    const request = {
      requestDigest: portableContextPlanRequestDigest(requestMaterial),
      ...requestMaterial,
    };
    const binding = {
      requestId: request.requestId,
      requestDigest: request.requestDigest,
    };
    const result = PortableContextPlanResultSchema.parse({
      status: "over_limit",
      ...binding,
      estimatedTokens: 120_000,
      maxInputTokens: 64_000,
      suggestedBoundaryMessageId: "message-2",
      message: "context exceeds the destination limit",
    });
    expect(portableContextPlanResultMatchesRequest(request, result)).toBe(true);
    expect(
      portableContextPlanResultMatchesRequest(request, {
        status: "over_limit",
        ...binding,
        maxInputTokens: 64_000,
        message: "provider reported that context exceeds the limit",
      }),
    ).toBe(true);
    const { digest: _digest, ...readyMaterial } = contextPlan();
    const oversizedMaterial = { ...readyMaterial, estimatedTokens: 120_000 };
    expect(
      portableContextPlanResultMatchesRequest(request, {
        status: "ready",
        ...binding,
        plan: {
          ...oversizedMaterial,
          digest: portableContextPlanDigest(oversizedMaterial),
        },
      }),
    ).toBe(false);
    expect(
      portableContextPlanResultMatchesRequest(request, {
        status: "over_limit",
        ...binding,
        estimatedTokens: 120_000,
        maxInputTokens: 32_000,
        suggestedBoundaryMessageId: "message-2",
        message: "context exceeds the destination limit",
      }),
    ).toBe(false);
    expect(
      portableContextPlanResultMatchesRequest(request, {
        ...result,
        requestId: "another-request",
      }),
    ).toBe(false);
    expect(() =>
      PortableContextPlanResultSchema.parse({
        status: "unsupported",
        message: "runner cannot import history",
      }),
    ).toThrow();
  });

  it("requires user or policy acceptance for an unchanged partial source", () => {
    const partialSourceMaterial = {
      ...sourceMaterial,
      completeness: "partial" as const,
      messages: [sourceMaterial.messages[0]!],
    };
    const partialSource = {
      ...partialSourceMaterial,
      digest: portableConversationContextDigest(partialSourceMaterial),
    };
    const planMaterial = {
      planId: "partial-plan",
      source: partialSource,
      destination: contextPlan().destination,
      messages: [
        {
          messageId: "message-1",
          action: "include" as const,
          parts: [{ partIndex: 0, action: "include" as const }],
        },
      ],
      context: partialSource,
      estimatedTokens: 5,
      requiresAcceptance: true,
    };
    const plan = PortableContextPlanSchema.parse({
      ...planMaterial,
      digest: portableContextPlanDigest(planMaterial),
    });
    expect(() => {
      const unsafeMaterial = { ...planMaterial, requiresAcceptance: false };
      PortableContextPlanSchema.parse({
        ...unsafeMaterial,
        digest: portableContextPlanDigest(unsafeMaterial),
      });
    }).toThrow(/either context is partial/);

    const transferMaterial = {
      operationId: "partial-transfer",
      plan,
      acceptance: {
        planDigest: plan.digest,
        acceptedAt: "2026-08-01T20:01:00.000Z",
        acceptedBy: "system" as const,
      },
    };
    expect(() =>
      ContextTransferRequestSchema.parse({
        requestDigest: contextTransferRequestDigest(transferMaterial),
        ...transferMaterial,
      }),
    ).toThrow(/requires user or policy acceptance/);
  });

  it("rejects an unapproved or mismatched transformed plan", () => {
    const plan = contextPlan();
    const systemMaterial = {
      operationId: "transfer-1",
      plan,
      acceptance: {
        planDigest: plan.digest,
        acceptedAt: "2026-08-01T20:01:00.000Z",
        acceptedBy: "system" as const,
      },
    };
    expect(() =>
      ContextTransferRequestSchema.parse({
        requestDigest: contextTransferRequestDigest(systemMaterial),
        ...systemMaterial,
      }),
    ).toThrow(/requires user or policy acceptance/);
    const mismatchMaterial = {
      operationId: "transfer-1",
      plan,
      acceptance: {
        planDigest: source.digest,
        acceptedAt: "2026-08-01T20:01:00.000Z",
        acceptedBy: "user" as const,
      },
    };
    expect(() =>
      ContextTransferRequestSchema.parse({
        requestDigest: contextTransferRequestDigest(mismatchMaterial),
        ...mismatchMaterial,
      }),
    ).toThrow(/must match/);
  });

  it("matches a fresh-session receipt exactly to the accepted plan", () => {
    const plan = contextPlan();
    const material = {
      operationId: "transfer-1",
      plan,
      acceptance: {
        planDigest: plan.digest,
        acceptedAt: "2026-08-01T20:01:00.000Z",
        acceptedBy: "user" as const,
      },
    };
    const request = ContextTransferRequestSchema.parse({
      requestDigest: contextTransferRequestDigest(material),
      ...material,
    });
    const receipt: ContextTransferReceipt = {
      status: "accepted",
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      planDigest: plan.digest,
      contextDigest: plan.context.digest,
      source: plan.source.source,
      destination: plan.destination,
      provider: "cli-bridge",
      environmentId: plan.destination.environmentId,
      sessionId: plan.destination.sessionId,
      runId: plan.destination.runId,
      executionId: plan.destination.executionId,
      sessionCreatedForOperationId: request.operationId,
      sessionCreatedAt: "2026-08-01T20:01:00.500Z",
      transferredMessageIds: ["message-1"],
      omittedMessageIds: ["message-2"],
      admittedAt: "2026-08-01T20:01:01.000Z",
    };
    expect(contextTransferReceiptMatches(request, receipt)).toBe(true);
    expect(contextTransferResultMatchesRequest(request, receipt)).toBe(true);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        sessionId: source.source.sessionId!,
      }),
    ).toBe(false);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        sessionCreatedAt: "2026-08-01T20:00:59.999Z",
      }),
    ).toBe(false);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        admittedAt: "2026-08-01T20:01:00.250Z",
      }),
    ).toBe(false);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        environmentId: source.source.environmentId!,
        sessionId: "session-new-in-source-environment",
      }),
    ).toBe(false);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        environmentId: source.source.environmentId!,
        sessionId: source.source.sessionId!,
      }),
    ).toBe(false);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        destination: { ...receipt.destination, runner: "kimi" },
      }),
    ).toBe(false);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        sessionCreatedForOperationId: "another-transfer",
      }),
    ).toBe(false);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        sessionId: "session-other",
        planDigest: source.digest,
      }),
    ).toBe(false);
    expect(
      contextTransferReceiptMatches(request, {
        ...receipt,
        provider: "",
      } as never),
    ).toBe(false);
    expect(
      ContextTransferResultSchema.parse({ ...receipt, status: "replayed" }),
    ).toMatchObject({ status: "replayed" });
    expect(
      ContextTransferResultSchema.parse({
        status: "conflict",
        operationId: request.operationId,
        requestDigest: `sha256:${"1".repeat(64)}`,
        existingRequestDigest: request.requestDigest,
      }),
    ).toMatchObject({ status: "conflict" });

    const invalidSource = {
      ...source,
      source: { ...source.source, sessionId: undefined },
    } as unknown as PortableConversationContext;
    const noSourceSessionMaterial = {
      operationId: "transfer-no-source-session",
      plan: { ...plan, source: invalidSource, context: { ...plan.context, source: invalidSource.source } },
      acceptance: {
        planDigest: plan.digest,
        acceptedAt: "2026-08-01T20:01:00.000Z",
        acceptedBy: "user" as const,
      },
    } as unknown as ContextTransferRequestMaterial;
    expect(
      ContextTransferRequestSchema.safeParse({
        requestDigest: `sha256:${"f".repeat(64)}`,
        ...noSourceSessionMaterial,
      }).success,
    ).toBe(false);
  });

  it.each(["conflict", "unknown", "transport_failure"] as const)(
    "binds a %s transfer result to its exact request",
    (status) => {
      const plan = contextPlan();
      const material = {
        operationId: "transfer-bound-result",
        plan,
        acceptance: {
          planDigest: plan.digest,
          acceptedAt: "2026-08-01T20:01:00.000Z",
          acceptedBy: "user" as const,
        },
      };
      const request = ContextTransferRequestSchema.parse({
        requestDigest: contextTransferRequestDigest(material),
        ...material,
      });
      const result = ContextTransferResultSchema.parse({
        status,
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        ...(status === "conflict"
          ? { existingRequestDigest: `sha256:${"9".repeat(64)}` }
          : { message: "not completed", retryable: status === "transport_failure" }),
      });

      expect(contextTransferResultMatchesRequest(request, result)).toBe(true);
      expect(
        contextTransferResultMatchesRequest(request, {
          ...result,
          operationId: "another-operation",
        }),
      ).toBe(false);
      expect(
        contextTransferResultMatchesRequest(request, {
          ...result,
          requestDigest: `sha256:${"8".repeat(64)}`,
        }),
      ).toBe(false);
    },
  );
});

describe("native continuation boundary", () => {
  const turnDigest = nativeContextContinuationTurnDigest({ prompt: "continue" });
  const exactRun = {
    runId: "run-source",
    provider: "cli-bridge",
    environmentId: "environment-source",
    sessionId: "session-source",
    executionId: "execution-source",
    requestDigest: source.source.requestDigest,
  };
  const proof = {
    runId: "run-source",
    provider: "cli-bridge",
    environmentId: "environment-source",
    sessionId: "session-source",
    executionId: "execution-source",
    requestDigest: source.source.requestDigest,
    boundary: { kind: "messages" as const, messageIds: ["message-1", "message-2"], digest: source.digest },
    observedAt: "2026-08-01T20:02:00.000Z",
  };

  it("rejects duplicate message identities in a native boundary", () => {
    expect(() =>
      NativeContextContinuationRequestSchema.parse({
        operationId: "continue-duplicates",
        requestDigest: `sha256:${"1".repeat(64)}`,
        run: exactRun,
        expectedBoundary: {
          ...proof,
          boundary: {
            kind: "messages",
            messageIds: ["message-1", "message-1"],
            digest: source.digest,
          },
        },
      }),
    ).toThrow(/message ids must be unique/);
  });

  it("requires the proof to match the retained run", () => {
    const material = {
      operationId: "continue-1",
      turnDigest,
      run: exactRun,
      expectedBoundary: proof,
    };
    const request = {
      requestDigest: nativeContextContinuationRequestDigest(material),
      ...material,
    };
    expect(NativeContextContinuationRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      NativeContextContinuationRequestSchema.parse({
        ...request,
        run: { ...request.run, sessionId: "session-wrong" },
      }),
    ).toThrow(/must match/);
    expect(() =>
      NativeContextContinuationRequestSchema.parse({
        ...request,
        run: { ...request.run, runId: "run-wrong" },
      }),
    ).toThrow(/must match/);

    const outcome = AgentNativeContextContinuationResultSchema.parse({
      acknowledgement: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: "accepted",
        historyMessagesSent: 0,
        actualBoundary: proof,
      },
      result: { text: "continued", success: true, sessionId: request.run.sessionId },
      controlRef: request.run,
    });
    expect(
      agentNativeContextContinuationResultMatchesRequest(request, outcome),
    ).toBe(true);
    expect(
      agentNativeContextContinuationResultMatchesRequest(request, {
        ...outcome,
        controlRef: { ...request.run, runId: "run-wrong" },
      }),
    ).toBe(false);
  });

  it("parses nonzero history but rejects it at the exact-match boundary", () => {
    const requestDigest = `sha256:${"1".repeat(64)}` as const;
    expect(
      NativeContextContinuationAcknowledgementSchema.parse({
        operationId: "continue-1",
        requestDigest,
        status: "accepted",
        historyMessagesSent: 0,
        actualBoundary: proof,
      }),
    ).toMatchObject({ status: "accepted" });
    const nonzeroHistory = NativeContextContinuationAcknowledgementSchema.parse({
      operationId: "continue-1",
      requestDigest,
      status: "accepted",
      historyMessagesSent: 2,
      actualBoundary: proof,
    });
    expect(nonzeroHistory.historyMessagesSent).toBe(2);
  });

  it("rejects invalid acknowledgements in the exact-match helper itself", () => {
    const material = {
      operationId: "continue-direct-check",
      turnDigest,
      run: exactRun,
      expectedBoundary: proof,
    };
    const request = NativeContextContinuationRequestSchema.parse({
      requestDigest: nativeContextContinuationRequestDigest(material),
      ...material,
    });
    expect(
      nativeContextContinuationAcknowledgementMatches(request, {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: "accepted",
        historyMessagesSent: 1,
      } as never),
    ).toBe(false);
    expect(
      nativeContextContinuationAcknowledgementMatches(request, {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: "accepted",
        historyMessagesSent: 0,
      } as never),
    ).toBe(false);
    expect(
      nativeContextContinuationAcknowledgementMatches(request, {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: "accepted",
        historyMessagesSent: 0,
        actualBoundary: {
          ...proof,
          boundary: { kind: "revision", revision: "wrong" },
        },
      }),
    ).toBe(false);
    expect(
      nativeContextContinuationAcknowledgementMatches(request, {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: "accepted",
        historyMessagesSent: 1,
        actualBoundary: proof,
      }),
    ).toBe(false);
    expect(
      nativeContextContinuationAcknowledgementMatches(request, {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: "accepted",
        historyMessagesSent: 0,
        actualBoundary: {
          ...proof,
          observedAt: "2026-08-01T20:01:59.999Z",
        },
      }),
    ).toBe(false);
  });

  it("binds replay and conflict acknowledgements to the exact operation", () => {
    const material = {
      operationId: "continue-1",
      turnDigest,
      run: exactRun,
      expectedBoundary: proof,
    };
    const request = NativeContextContinuationRequestSchema.parse({
      requestDigest: nativeContextContinuationRequestDigest(material),
      ...material,
    });
    const replay = NativeContextContinuationAcknowledgementSchema.parse({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      status: "replayed",
      historyMessagesSent: 0,
      actualBoundary: proof,
    });
    expect(
      nativeContextContinuationAcknowledgementMatches(request, replay),
    ).toBe(true);
    expect(
      NativeContextContinuationAcknowledgementSchema.parse({
        operationId: request.operationId,
        requestDigest: `sha256:${"2".repeat(64)}`,
        existingRequestDigest: request.requestDigest,
        status: "conflict",
        historyMessagesSent: 0,
      }),
    ).toMatchObject({ status: "conflict" });
  });

  it.each([
    "conflict",
    "boundary_mismatch",
    "unverified",
    "unknown_session",
    "transport_failure",
  ] as const)("does not accept a %s native continuation", (status) => {
    const material = {
      operationId: "continue-failure",
      turnDigest,
      run: exactRun,
      expectedBoundary: proof,
    };
    const request = NativeContextContinuationRequestSchema.parse({
      requestDigest: nativeContextContinuationRequestDigest(material),
      ...material,
    });
    const acknowledgement = NativeContextContinuationAcknowledgementSchema.parse({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      status,
      historyMessagesSent: 0,
      ...(status === "conflict"
        ? { existingRequestDigest: `sha256:${"2".repeat(64)}` }
        : {}),
      ...(status === "boundary_mismatch"
        ? {
            actualBoundary: {
              ...proof,
              boundary: { kind: "revision", revision: "different" },
            },
          }
        : {}),
      ...(status === "transport_failure"
        ? { message: "network error", retryable: true }
        : {}),
    });
    expect(
      nativeContextContinuationAcknowledgementMatches(
        request,
        acknowledgement,
      ),
    ).toBe(false);
  });

  it("requires explicit retry safety for native transport failures", () => {
    expect(() =>
      NativeContextContinuationAcknowledgementSchema.parse({
        operationId: "continue-1",
        requestDigest: `sha256:${"1".repeat(64)}`,
        status: "transport_failure",
        historyMessagesSent: 0,
        message: "network error",
      }),
    ).toThrow(/retry is safe/);
  });
});
