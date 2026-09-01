import { describe, expect, it, vi } from "vitest";
import {
  AgentEnvironmentCapabilitiesSchema,
  AgentEnvironmentCreationSchema,
  AgentEnvironmentEgressPolicySchema,
  AgentNativeContextContinuationAdmissionSchema,
  AgentNativeContextContinuationResultSchema,
  agentNativeContextContinuationAdmissionMatchesRequest,
  agentNativeContextContinuationResultMatchesRequest,
  agentEnvironmentCreateInputDigest,
  createAgentEnvironmentWithIdempotency,
  replayedAgentEnvironmentView,
} from "./environment-provider.js";
import type {
  AgentEnvironmentCreateIdempotencyRecord,
  AgentEnvironmentCreation,
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
    cwdBases: { repository: true, host: true },
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

describe("generic environment create idempotency", () => {
  const input = {
    profile: { name: "worker" },
    metadata: { z: 1, a: 2 },
    idempotencyKey: "create-1",
    signal: new AbortController().signal,
  };

  it("uses canonical create material without the key or attempt signal", () => {
    expect(
      agentEnvironmentCreateInputDigest(input),
    ).toBe(
      agentEnvironmentCreateInputDigest({
        signal: new AbortController().signal,
        idempotencyKey: "create-1",
        metadata: { a: 2, z: 1 },
        profile: { name: "worker" },
      }),
    );
    expect(
      agentEnvironmentCreateInputDigest({ ...input, metadata: { a: 3, z: 1 } }),
    ).not.toBe(agentEnvironmentCreateInputDigest(input));
    expect(
      agentEnvironmentCreateInputDigest({ ...input, requestedId: "environment-exact" }),
    ).not.toBe(agentEnvironmentCreateInputDigest(input));
  });

  type FakeEnvironment = {
    id: string;
    creation?: AgentEnvironmentCreation;
    status: () => Promise<string>;
  };

  it("coalesces same-key retries into replayed views and rejects changed input", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<FakeEnvironment>
    >();
    const status = async () => "running";
    const create = vi.fn(
      async (): Promise<FakeEnvironment> => ({
        id: "environment-1",
        creation: "created",
        status,
      }),
    );

    const first = await createAgentEnvironmentWithIdempotency(
      records,
      input,
      create,
    );
    const replay = await createAgentEnvironmentWithIdempotency(
      records,
      {
        profile: { name: "worker" },
        metadata: { a: 2, z: 1 },
        idempotencyKey: "create-1",
        signal: new AbortController().signal,
      },
      create,
    );

    expect(first.creation).toBe("created");
    expect(replay).not.toBe(first);
    expect(replay).toEqual({ id: "environment-1", creation: "replayed", status });
    expect(replay.status).toBe(first.status);
    expect(first.creation).toBe("created");
    expect(create).toHaveBeenCalledOnce();
    await expect(
      createAgentEnvironmentWithIdempotency(
        records,
        { ...input, metadata: { a: 3, z: 1 } },
        create,
      ),
    ).rejects.toThrow(/conflicts with a different create input/);
    expect(create).toHaveBeenCalledOnce();

    const aborted = new AbortController();
    aborted.abort(new Error("retry cancelled"));
    await expect(
      createAgentEnvironmentWithIdempotency(
        records,
        { ...input, signal: aborted.signal },
        create,
      ),
    ).rejects.toThrow("retry cancelled");
  });

  it("gives every caller that awaited one pending create a replayed view", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<FakeEnvironment>
    >();
    let release: (environment: FakeEnvironment) => void = () => {};
    const create = vi.fn(
      () =>
        new Promise<FakeEnvironment>((resolve) => {
          release = resolve;
        }),
    );

    const firstCall = createAgentEnvironmentWithIdempotency(records, input, create);
    const secondCall = createAgentEnvironmentWithIdempotency(records, input, create);
    await Promise.resolve();
    release({ id: "environment-1", status: async () => "running" });

    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(create).toHaveBeenCalledOnce();
    expect(first.creation).toBeUndefined();
    expect(second.creation).toBe("replayed");
    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);
  });

  it("keeps an unkeyed create verdict as the provider stated it", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<FakeEnvironment>
    >();
    const { idempotencyKey: _key, ...unkeyed } = input;
    const environment = await createAgentEnvironmentWithIdempotency(
      records,
      unkeyed,
      async (): Promise<FakeEnvironment> => ({
        id: "environment-2",
        status: async () => "running",
      }),
    );
    expect(environment.creation).toBeUndefined();
    expect(records.size).toBe(0);
  });

  it("refuses a replayed view of a class instance", () => {
    class Environment {
      readonly id = "environment-1";
      readonly creation = "created" as const;
      status(): Promise<string> {
        return Promise.resolve(this.id);
      }
    }
    expect(() => replayedAgentEnvironmentView(new Environment())).toThrow(
      /plain object environment/,
    );
    expect(
      replayedAgentEnvironmentView(
        Object.assign(Object.create(null) as object, { id: "environment-1" }),
      ),
    ).toEqual({ id: "environment-1", creation: "replayed" });
  });
});

describe("AgentEnvironmentCreationSchema", () => {
  it("accepts the two provable verdicts and rejects every other value", () => {
    expect(AgentEnvironmentCreationSchema.parse("created")).toBe("created");
    expect(AgentEnvironmentCreationSchema.parse("replayed")).toBe("replayed");
    for (const invalid of ["unknown", "", "CREATED", undefined, null, true]) {
      expect(() => AgentEnvironmentCreationSchema.parse(invalid)).toThrow();
    }
  });
});

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
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        workspace: {
          ...capabilities.workspace,
          cwdBases: { repository: "yes", host: false },
        },
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
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        retainedControl: undefined,
        nativeContinuation: {
          atomicBoundary: true,
          requestIdempotency: true,
          admissionControl: true,
        },
      }),
    ).toThrow(/retained control for early admission/);
  });

  it("advertises context transfer only with every durable admission guarantee", () => {
    const contextTransfer = {
      freshSession: true,
      requestIdempotency: true,
      lookup: true,
    };
    expect(
      AgentEnvironmentCapabilitiesSchema.parse({ ...capabilities, contextTransfer }),
    ).toMatchObject({ contextTransfer });
    for (const field of Object.keys(contextTransfer) as Array<keyof typeof contextTransfer>) {
      expect(() => AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        contextTransfer: { ...contextTransfer, [field]: false },
      })).toThrow(/fresh-session admission, request idempotency, and lookup together/);
    }
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

  it("requires interactive agent controls to name the operations they depend on", () => {
    const complete = {
      start: true,
      control: true,
      status: true,
      attach: true,
      reattach: true,
      sendPrompt: true,
      input: true,
      resize: true,
      stop: true,
    };
    expect(
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: complete,
      }),
    ).toMatchObject({ interactiveAgent: complete });

    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: { ...complete, start: false },
      }),
    ).toThrow(/each require start/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: { ...complete, attach: false },
      }),
    ).toThrow(/each require attach/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: { ...complete, control: false },
      }),
    ).toThrow(/provider-issued control claims/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: { ...complete, input: "yes" },
      }),
    ).toThrow();
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

  it("validates and exactly binds early continuation admission", () => {
    const admission = AgentNativeContextContinuationAdmissionSchema.parse({
      phase: "admitted",
      acknowledgement: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        historyMessagesSent: 0,
        actualBoundary: expectedBoundary,
      },
      controlRef: outcome.controlRef,
    });
    expect(
      agentNativeContextContinuationAdmissionMatchesRequest(request, admission),
    ).toBe(true);
    expect(
      agentNativeContextContinuationAdmissionMatchesRequest(request, {
        ...admission,
        acknowledgement: {
          ...admission.acknowledgement,
          operationId: "another-operation",
        },
      }),
    ).toBe(false);
    expect(() =>
      AgentNativeContextContinuationAdmissionSchema.parse({
        ...admission,
        controlRef: { ...admission.controlRef, sessionId: "another-session" },
      }),
    ).toThrow(/must stay in the retained session/);
  });

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

describe("AgentEnvironmentEgressPolicySchema", () => {
  it("accepts each mode and carries a strict allowlist", () => {
    expect(AgentEnvironmentEgressPolicySchema.parse({ mode: "open" })).toEqual({
      mode: "open",
    });
    expect(AgentEnvironmentEgressPolicySchema.parse({ mode: "blocked" })).toEqual({
      mode: "blocked",
    });
    expect(
      AgentEnvironmentEgressPolicySchema.parse({
        mode: "strict",
        allowDomains: ["api.example.com"],
      }),
    ).toEqual({ mode: "strict", allowDomains: ["api.example.com"] });
    expect(AgentEnvironmentEgressPolicySchema.parse({ mode: "strict" })).toEqual({
      mode: "strict",
    });
  });

  it("refuses a domain list outside strict mode rather than carrying an ignored one", () => {
    for (const mode of ["open", "blocked"]) {
      expect(() =>
        AgentEnvironmentEgressPolicySchema.parse({
          mode,
          allowDomains: ["api.example.com"],
        }),
      ).toThrow();
    }
  });

  it("refuses a domain that matches no host", () => {
    // A whitespace-only or outer-padded entry is an allowlist the caller believes is in force
    // and is not. It is rejected rather than trimmed: trimming would accept a typo.
    for (const domain of ["", " ", "  api.example.com  ", "api.example.com "]) {
      expect(() =>
        AgentEnvironmentEgressPolicySchema.parse({
          mode: "strict",
          allowDomains: [domain],
        }),
      ).toThrow();
    }
  });

  it("refuses an unknown mode and an unknown field", () => {
    expect(() =>
      AgentEnvironmentEgressPolicySchema.parse({ mode: "permissive" }),
    ).toThrow();
    expect(() =>
      AgentEnvironmentEgressPolicySchema.parse({
        mode: "open",
        includeImplicitDomains: true,
      }),
    ).toThrow();
  });

  it("makes an egress policy part of the create identity", () => {
    const base = { profile: { name: "worker" } } as const;
    const open = agentEnvironmentCreateInputDigest({
      ...base,
      egress: { mode: "open" },
    });
    const blocked = agentEnvironmentCreateInputDigest({
      ...base,
      egress: { mode: "blocked" },
    });
    const owned = agentEnvironmentCreateInputDigest({
      ...base,
      billingOwner: "usr_funded_account",
    });
    expect(open).not.toBe(blocked);
    expect(open).not.toBe(agentEnvironmentCreateInputDigest(base));
    expect(owned).not.toBe(agentEnvironmentCreateInputDigest(base));
  });
});

describe("AgentEnvironmentCapabilities.create", () => {
  it("states either honored field on its own", () => {
    for (const create of [
      { egress: ["open", "strict", "blocked"] },
      { billingOwner: true },
      { egress: ["open"], billingOwner: false },
    ]) {
      const document = { ...capabilities, create };
      expect(AgentEnvironmentCapabilitiesSchema.parse(document)).toEqual(document);
    }
  });

  it("refuses a block that states no honored field", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({ ...capabilities, create: {} }),
    ).toThrow(/at least one honored field/);
  });

  it("refuses a repeated egress mode, as the exact-process sibling does", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        create: { egress: ["open", "open"] },
      }),
    ).toThrow(/must be unique/);
  });

  it("refuses an unknown mode and an unknown member", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        create: { egress: ["permissive"] },
      }),
    ).toThrow();
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        create: { egress: ["open"], secrets: true },
      }),
    ).toThrow();
  });
});
