import {
  AgentNativeContextContinuationResultSchema,
  NativeContextContinuationRequestSchema,
  agentNativeContextContinuationResultMatchesRequest,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
} from "@tangle-network/agent-interface";
import type { AgentExactRunControlRef } from "@tangle-network/agent-interface";
import { Sandbox } from "@tangle-network/sandbox";
import type { SandboxEvent } from "@tangle-network/sandbox";
import { describe, expect, it } from "vitest";
import { createTangleProvider } from "./index.js";
import { retainedDeployment } from "./retained-control-test-helpers.js";
import type { SandboxInstanceLike, SandboxSessionLike } from "./tangle-types.js";

// A retained sandbox whose session accepts follow-up prompts, recording each
// one. The adapter mints every execution id itself and the sandbox echoes it,
// exactly as the real deployment does, so the continued run's identity is
// whatever the adapter derived from the turn and its operation id.
function fixture() {
  const prompts: Array<{ options: Record<string, unknown> | undefined }> = [];
  let lastExecutionId: string | undefined;
  const sandboxSession: SandboxSessionLike = {
    id: "session-continue",
    status: async () => ({ status: "running" }),
    async *events() {},
    result: async (options) => ({
      success: true,
      status: "success",
      executionId: options?.executionId ?? lastExecutionId,
      durationMs: 1,
    }),
    prompt: async (_message, options) => {
      prompts.push({ options: options as Record<string, unknown> | undefined });
      lastExecutionId = options?.executionId;
      return {
        success: true,
        status: "success",
        executionId: options?.executionId,
        durationMs: 1,
      };
    },
    interrupt: async () => ({ cancelled: true }),
    // Retained control, and with it native continuation, is claimed only when
    // the session carries canonical cancellation and the client can
    // reconstruct the environment by id.
    cancelRun: async (request) => ({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      run: request.run,
      status: "accepted",
      effect: "not_live",
    }),
  };
  const box: SandboxInstanceLike = retainedDeployment({
    id: "sbx-continue",
    async *streamPrompt() {
      yield {
        type: "status",
        data: { status: "processing", sessionId: "session-continue" },
      } as SandboxEvent;
    },
    dispatchPrompt: async (_prompt, options) => {
      lastExecutionId = options?.executionId;
      return {
        sessionId: options?.sessionId,
        executionId: options?.executionId,
        runControlRef: options?.runControlRef,
      };
    },
    session: () => sandboxSession,
  });
  return { box, prompts };
}

async function continuedSession() {
  const { box, prompts } = fixture();
  const provider = createTangleProvider({
    client: { create: async () => box, get: async () => box },
  });
  const environment = await provider.create({ profile: { name: "worker" } });
  const dispatched = await environment.dispatch!({
    prompt: "run",
    sessionId: "session-continue",
  });
  const session = environment.session!("session-continue", {
    controlRef: dispatched.controlRef,
  });
  return { provider, environment, session, prompts };
}

describe("Tangle native continuation", () => {
  it("advertises native continuation together with retained control", async () => {
    // The published SDK client's own class surface is what the provider-level
    // probe reads; the same facts that grant retained control grant this.
    const provider = createTangleProvider({
      client: new Sandbox({ apiKey: "test-key", baseUrl: "http://127.0.0.1:1" }),
    });
    await expect(provider.capabilities()).resolves.toMatchObject({
      sessions: { continue: true },
      retainedControl: { cancellationIdempotency: true },
      nativeContinuation: { atomicBoundary: true, requestIdempotency: true },
    });

    // Without reconstruction neither is claimed.
    const withoutReconstruction = createTangleProvider({
      client: {
        create: async () => {
          throw new Error("capabilities never create a sandbox");
        },
      },
    });
    const narrowed = await withoutReconstruction.capabilities();
    expect(narrowed).not.toHaveProperty("retainedControl");
    expect(narrowed).not.toHaveProperty("nativeContinuation");
  });

  it("reports the executing run as the conversation boundary", async () => {
    const { session } = await continuedSession();
    expect(typeof session.contextBoundary).toBe("function");
    expect(typeof session.continueNative).toBe("function");
    const proof = await session.contextBoundary!();
    expect(proof).not.toBeNull();
    const run = session.controlRef as AgentExactRunControlRef;
    expect(proof).toMatchObject({
      runId: run.runId,
      sessionId: "session-continue",
      executionId: run.executionId,
      requestDigest: run.requestDigest,
      boundary: { kind: "revision", revision: run.executionId },
    });
  });

  // The same shape the provider testkit's portable-context conformance proves,
  // without its planning and transfer halves, which this adapter does not offer.
  it("continues once, replays the retry, and refuses a moved boundary or a changed turn", async () => {
    const { session, prompts } = await continuedSession();
    const run = session.controlRef as AgentExactRunControlRef;
    const proof = (await session.contextBoundary!())!;
    const turn = { prompt: "carry on" };
    const material = {
      operationId: "continue-op-1",
      turnDigest: nativeContextContinuationTurnDigest(turn),
      run,
      expectedBoundary: proof,
    };
    const continuation = NativeContextContinuationRequestSchema.parse({
      requestDigest: nativeContextContinuationRequestDigest(material),
      ...material,
    });
    const before = prompts.length;

    // A boundary the conversation has moved past dispatches nothing.
    const mismatchMaterial = {
      ...material,
      operationId: "continue-op-1-mismatch",
      expectedBoundary: {
        ...proof,
        boundary: { kind: "revision" as const, revision: "another-run" },
      },
    };
    const mismatch = NativeContextContinuationRequestSchema.parse({
      requestDigest: nativeContextContinuationRequestDigest(mismatchMaterial),
      ...mismatchMaterial,
    });
    const mismatched = AgentNativeContextContinuationResultSchema.parse(
      await session.continueNative!(mismatch, { turn }),
    );
    expect(mismatched.acknowledgement.status).toBe("boundary_mismatch");
    expect(mismatched.acknowledgement.actualBoundary?.boundary).toEqual(proof.boundary);
    expect(prompts.length).toBe(before);

    // A matching boundary continues exactly once, on the session, under the
    // operation id, and advances the control reference to the continued run.
    const accepted = AgentNativeContextContinuationResultSchema.parse(
      await session.continueNative!(continuation, { turn }),
    );
    expect(accepted.acknowledgement.status).toBe("accepted");
    expect(accepted.acknowledgement.historyMessagesSent).toBe(0);
    expect(agentNativeContextContinuationResultMatchesRequest(continuation, accepted)).toBe(
      true,
    );
    expect(prompts.length).toBe(before + 1);
    expect(prompts[before]?.options?.sessionId).toBe("session-continue");
    expect(prompts[before]?.options?.turnId).toBe("continue-op-1");
    if (!("controlRef" in accepted)) throw new Error("accepted continuation carries no control reference");
    expect(accepted.controlRef.executionId).not.toBe(run.executionId);
    expect(session.controlRef?.executionId).toBe(accepted.controlRef.executionId);

    // A retry of the same request replays the recorded result and dispatches nothing.
    const replayed = AgentNativeContextContinuationResultSchema.parse(
      await session.continueNative!(continuation, { turn }),
    );
    expect(replayed.acknowledgement.status).toBe("replayed");
    if (!("result" in replayed)) throw new Error("replayed continuation carries no result");
    expect(replayed.result).toEqual(accepted.result);
    expect(replayed.controlRef).toEqual(accepted.controlRef);
    expect(prompts.length).toBe(before + 1);

    // A different turn under the same operation id is a conflict, not a second run.
    const changedTurn = { prompt: "carry on, changed" };
    const changedMaterial = {
      ...material,
      turnDigest: nativeContextContinuationTurnDigest(changedTurn),
    };
    const changed = NativeContextContinuationRequestSchema.parse({
      requestDigest: nativeContextContinuationRequestDigest(changedMaterial),
      ...changedMaterial,
    });
    const conflict = AgentNativeContextContinuationResultSchema.parse(
      await session.continueNative!(changed, { turn: changedTurn }),
    );
    expect(conflict.acknowledgement.status).toBe("conflict");
    expect(conflict.acknowledgement.existingRequestDigest).toBe(continuation.requestDigest);
    expect(prompts.length).toBe(before + 1);
  });

  it("refuses a continuation aimed at another run or carrying a turn its digest does not name", async () => {
    const { session } = await continuedSession();
    const run = session.controlRef as AgentExactRunControlRef;
    const proof = (await session.contextBoundary!())!;
    const turn = { prompt: "carry on" };
    // The request schema refuses a run that disagrees with its own boundary
    // proof, so a request for another run must be self-consistent about that
    // run; the adapter is what refuses it, because it is not the run in hand.
    const foreignExecutionId = `${run.executionId}-other`;
    const foreignRun = { ...run, executionId: foreignExecutionId };
    const foreignMaterial = {
      operationId: "continue-op-2",
      turnDigest: nativeContextContinuationTurnDigest(turn),
      run: foreignRun,
      expectedBoundary: {
        ...proof,
        executionId: foreignExecutionId,
        boundary: { kind: "revision" as const, revision: foreignExecutionId },
      },
    };
    const foreign = NativeContextContinuationRequestSchema.parse({
      requestDigest: nativeContextContinuationRequestDigest(foreignMaterial),
      ...foreignMaterial,
    });
    await expect(session.continueNative!(foreign, { turn })).rejects.toThrow(
      /targets another retained run/,
    );
    const material = {
      operationId: "continue-op-3",
      turnDigest: nativeContextContinuationTurnDigest(turn),
      run,
      expectedBoundary: proof,
    };
    const request = NativeContextContinuationRequestSchema.parse({
      requestDigest: nativeContextContinuationRequestDigest(material),
      ...material,
    });
    await expect(
      session.continueNative!(request, { turn: { prompt: "not that turn" } }),
    ).rejects.toThrow(/does not match its request digest/);
  });
});
