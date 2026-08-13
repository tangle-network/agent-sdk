import { describe, expect, it } from "vitest";
import {
  AgentEnvironmentCapabilitiesSchema,
  AgentNativeContextContinuationResultSchema,
  agentNativeContextContinuationResultMatchesRequest,
} from "./environment-provider.js";
import {
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
} from "./portable-context.js";

const capabilities = {
  profile: {
    namedProfiles: true,
    systemPrompt: { replace: true, append: true },
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: { files: true, instructions: true },
    runtimeUpdate: true,
    validation: true,
  },
  streaming: {
    live: true,
    replay: true,
    detach: true,
    turnIdempotency: true,
  },
  sessions: { continue: true, list: true, messages: true },
  nativeContinuation: { atomicBoundary: true, requestIdempotency: true },
  workspace: {
    read: true,
    write: true,
    exec: true,
    git: true,
    upload: true,
    download: true,
  },
  branching: {
    checkpoint: true,
    fork: true,
    retrySafe: true,
    lookup: true,
    cleanup: true,
  },
  placement: true,
  usage: true,
  confidential: false,
  exactProcess: { egress: ["blocked", "strict"] as const },
  observation: {
    identity: true,
    lifecycle: true,
    endpoint: true,
    placement: true,
    resources: true,
    resourceUse: true,
    modelUsage: true,
    computeBilling: true,
    accountUsage: true,
  },
  interactiveTerminal: {
    attach: true,
    input: true,
    resize: true,
    reattach: true,
  },
};

describe("AgentEnvironmentCapabilitiesSchema", () => {
  it("accepts a complete strict capability document", () => {
    expect(AgentEnvironmentCapabilitiesSchema.parse(capabilities)).toEqual(
      capabilities,
    );
  });

  it("rejects malformed booleans and unknown capability fields", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        workspace: { ...capabilities.workspace, read: "yes" },
      }),
    ).toThrow();
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        providerNativeBypass: true,
      }),
    ).toThrow();
  });

  it("requires both system-prompt intents to be declared independently", () => {
    for (const systemPrompt of [
      true,
      false,
      { replace: true },
      { append: true },
      { replace: true, append: true, prepend: true },
    ]) {
      expect(() =>
        AgentEnvironmentCapabilitiesSchema.parse({
          ...capabilities,
          profile: { ...capabilities.profile, systemPrompt },
        }),
      ).toThrow();
    }

    for (const systemPrompt of [
      { replace: false, append: false },
      { replace: false, append: true },
      { replace: true, append: false },
      { replace: true, append: true },
    ]) {
      const document = {
        ...capabilities,
        profile: { ...capabilities.profile, systemPrompt },
      };
      expect(AgentEnvironmentCapabilitiesSchema.parse(document)).toEqual(
        document,
      );
    }
  });

  it("requires durable branching features to be all-or-nothing", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        branching: {
          ...capabilities.branching,
          cleanup: false,
        },
      }),
    ).toThrow(/requires checkpoint, fork, lookup, and cleanup together/);
  });

  it("requires native continuation admission and retry safety together", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        nativeContinuation: { atomicBoundary: true, requestIdempotency: false },
      }),
    ).toThrow(/requires session continuation, atomic boundary admission, and request idempotency together/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        sessions: { ...capabilities.sessions, continue: false },
      }),
    ).toThrow(/requires session continuation/);
  });

  it("advertises retained run control only with every identity guarantee", () => {
    const retainedControl = {
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    };
    expect(
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        retainedControl,
      }),
    ).toMatchObject({ retainedControl });
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        retainedControl: { ...retainedControl, resultIdentity: false },
      }),
    ).toThrow(/retained control requires exact run/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        streaming: { ...capabilities.streaming, detach: false },
        retainedControl,
      }),
    ).toThrow(/retained control requires exact run/);
  });

  it("accepts observation surfaces declared independently", () => {
    for (const observation of [
      {
        identity: false,
        lifecycle: false,
        endpoint: true,
        placement: false,
        resources: false,
        resourceUse: false,
        modelUsage: false,
        computeBilling: false,
        accountUsage: false,
      },
      {
        identity: true,
        lifecycle: true,
        endpoint: false,
        placement: true,
        resources: true,
        resourceUse: false,
        modelUsage: true,
        computeBilling: false,
        accountUsage: true,
      },
    ]) {
      const document = { ...capabilities, observation };
      expect(AgentEnvironmentCapabilitiesSchema.parse(document)).toEqual(document);
    }
  });

  it("requires interactive terminal input, resize, and reattach to imply attach", () => {
    for (const interactiveTerminal of [
      { attach: false, input: true, resize: false, reattach: false },
      { attach: false, input: false, resize: true, reattach: false },
      { attach: false, input: false, resize: false, reattach: true },
    ]) {
      expect(() =>
        AgentEnvironmentCapabilitiesSchema.parse({
          ...capabilities,
          interactiveTerminal,
        }),
      ).toThrow(/input, resize, and reattach each require attach/);
    }
    const attachOnly = {
      ...capabilities,
      interactiveTerminal: {
        attach: true,
        input: false,
        resize: false,
        reattach: false,
      },
    };
    expect(AgentEnvironmentCapabilitiesSchema.parse(attachOnly)).toEqual(attachOnly);
  });

  it("rejects duplicate open capability values", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        profile: {
          ...capabilities.profile,
          extensions: ["vendor", "vendor"],
        },
      }),
    ).toThrow(/extension namespaces must be unique/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        exactProcess: { egress: ["blocked", "blocked"] },
      }),
    ).toThrow(/egress modes must be unique/);
  });
});

describe("AgentNativeContextContinuationResultSchema", () => {
  const run = {
    runId: "run-before",
    provider: "cli-bridge",
    environmentId: "environment-1",
    sessionId: "session-1",
    executionId: "execution-before",
    requestDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
  };
  const expectedBoundary = {
    runId: run.runId,
    provider: run.provider,
    environmentId: run.environmentId,
    sessionId: run.sessionId,
    executionId: run.executionId,
    requestDigest: run.requestDigest,
    boundary: { kind: "revision" as const, revision: "revision-before" },
    observedAt: "2026-08-01T20:00:00.000Z",
  };
  const material = {
    operationId: "continue-1",
    turnDigest: nativeContextContinuationTurnDigest({ prompt: "continue" }),
    run,
    expectedBoundary,
  };
  const request = {
    ...material,
    requestDigest: nativeContextContinuationRequestDigest(material),
  };
  const outcome = {
    acknowledgement: {
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      status: "accepted" as const,
      historyMessagesSent: 0,
      actualBoundary: expectedBoundary,
    },
    result: { text: "done", success: true, sessionId: run.sessionId },
    controlRef: {
      ...run,
      runId: "run-after",
      executionId: "execution-after",
      requestDigest: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
    },
  };

  it("validates and exactly binds a successful continuation outcome", () => {
    const parsed = AgentNativeContextContinuationResultSchema.parse(outcome);
    expect("controlRef" in parsed).toBe(true);
    if (!("controlRef" in parsed)) throw new Error("expected successful outcome");
    expect(
      agentNativeContextContinuationResultMatchesRequest(request, parsed),
    ).toBe(true);
    expect(
      agentNativeContextContinuationResultMatchesRequest(request, {
        ...parsed,
        controlRef: { ...parsed.controlRef, sessionId: "wrong-session" },
      }),
    ).toBe(false);
  });

  it("requires current control coordinates only for successful outcomes", () => {
    expect(() =>
      AgentNativeContextContinuationResultSchema.parse({
        acknowledgement: outcome.acknowledgement,
        result: outcome.result,
      }),
    ).toThrow();
    expect(
      AgentNativeContextContinuationResultSchema.parse({
        acknowledgement: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          status: "unknown_session",
          historyMessagesSent: 0,
        },
      }),
    ).toMatchObject({ acknowledgement: { status: "unknown_session" } });
    expect(() =>
      AgentNativeContextContinuationResultSchema.parse({
        acknowledgement: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          status: "unknown_session",
          historyMessagesSent: 0,
        },
        result: outcome.result,
      }),
    ).toThrow();
    expect(() =>
      AgentNativeContextContinuationResultSchema.parse({
        acknowledgement: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          status: "transport_failure",
          historyMessagesSent: 0,
          message: "outcome unknown",
          retryable: false,
        },
      }),
    ).toThrow(/must be retryable/);
  });
});
