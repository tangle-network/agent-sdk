import { describe, expect, it, vi } from "vitest";
import type {
  PortableContextPlanRequest,
  PortableContextPlanResult,
} from "@tangle-network/agent-interface";
import {
  assert,
  collect,
  deepEqual,
  isTerminalEvent,
  withEnvironmentCleanup,
} from "./conformance-helpers.js";
import { ProviderConformanceError } from "./conformance-types.js";
import {
  abortable,
  bytesEqual,
  terminationEqual,
} from "./exact-process-helpers.js";
import { runAgentExactProcessProviderLifecycleChecks } from "./exact-process-conformance.js";
import { runInteractionResponseConformance } from "./interaction-conformance.js";
import {
  assertNoContextEffects,
  assertPortablePlanCoversRequest,
  differentBoundary,
} from "./portable-context-helpers.js";
import { runPortableContextConformance } from "./portable-context-conformance.js";
import { runAgentEnvironmentProviderConformance } from "./provider-conformance.js";
import { runSessionReplayConformance } from "./session-replay-conformance.js";
import { runWorkspaceBranchingConformance } from "./workspace-branching-conformance.js";
import { cleanupWorkspaceResources } from "./workspace-cleanup-conformance.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as `sha256:${string}`;

const source = {
  runId: "run-1",
  messageId: "message-1",
  provider: "provider-a",
  environmentId: "environment-a",
  sessionId: "session-a",
  executionId: "execution-a",
  requestDigest: digest("a"),
};

const destination = {
  runner: "runner-b",
  provider: "provider-b",
  environmentId: "environment-b",
  sessionId: "session-b",
  runId: "run-b",
  executionId: "execution-b",
  profileDigest: digest("b"),
};

const sourceContext = {
  source,
  completeness: "complete" as const,
  messages: [{
    id: "message-1",
    role: "user" as const,
    parts: [{ type: "text" as const, text: "hello" }],
    timestamp: "2026-08-01T20:00:00.000Z",
  }],
  attachments: [],
  digest: digest("c"),
};

describe("testkit split leaf modules", () => {
  it("directly exercises helpers, bounds, cleanup ownership, and abort replay", async () => {
    const checked: string[] = [];
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(terminationEqual({ kind: "exit", exitCode: 0 }, { kind: "exit", exitCode: 0 })).toBe(true);
    expect(isTerminalEvent({ type: "status", data: { status: "completed" } })).toBe(true);
    expect(collect((async function* () { yield "event"; })())).resolves.toEqual(["event"]);
    expect(() => assert(false, "bounded failure", checked)).toThrow(ProviderConformanceError);
    expect(checked).toEqual([]);
    expect(() => assertNoContextEffects(
      { plans: 0, transfers: 0, freshSessions: 0, nativeContinuations: 0 },
      { plans: 1, transfers: 1, freshSessions: 0, nativeContinuations: 0 },
      checked,
    )).toThrow();
    expect(differentBoundary({ kind: "token", token: "boundary" })).toEqual({ kind: "token", token: "boundary-different" });
    const cleanup = vi.fn(async () => undefined);
    const environment = { id: "environment-1", provider: "test", destroy: cleanup } as never;
    await expect(withEnvironmentCleanup(environment, checked, async () => {
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");
    expect(cleanup).toHaveBeenCalledOnce();
    const pending = new Promise<string>(() => undefined);
    const controller = new AbortController();
    const aborted = abortable(pending, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(aborted).rejects.toThrow("cancelled");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(abortable(Promise.resolve("late"), alreadyAborted.signal)).rejects.toThrow();
  });

  it("directly runs each conformance leaf through its fail-closed entry path", async () => {
    const invalidProvider = { capabilities: async () => ({}) } as never;
    await expect(runAgentEnvironmentProviderConformance({ name: "invalid", createProvider: async () => invalidProvider })).rejects.toThrow();
    await expect(runSessionReplayConformance({ name: "invalid", createProvider: async () => invalidProvider, turn: { prompt: "x" }, reconnect: async () => ({}) as never })).rejects.toThrow();
    await expect(runInteractionResponseConformance({ name: "invalid", request: {} as never, command: {} as never, statusCases: [], respond: async () => ({}) as never })).rejects.toThrow();
    await expect(runPortableContextConformance({ name: "invalid", request: {} as never, rejectionRequest: {} as never, run: {} as never, acceptedAt: "invalid", turn: { prompt: "continue" }, plan: async () => ({}) as never, transfer: async () => ({}) as never, boundary: async () => null, continueNative: async () => ({}) as never, counters: () => ({ plans: 0, transfers: 0, freshSessions: 0, nativeContinuations: 0 }) })).rejects.toThrow();
    await expect(runWorkspaceBranchingConformance({ name: "invalid", operations: {} as never, checkpointRequest: {} as never, forkRequest: () => ({}) as never })).rejects.toThrow();
    await expect(runAgentExactProcessProviderLifecycleChecks({ createProvider: async () => invalidProvider, createInput: {} as never, launch: {} as never, expectedStdout: "", expectedStderr: "" })).rejects.toThrow();
    await expect(cleanupWorkspaceResources({ operations: {} as never })).resolves.toEqual([]);
  });

  it("checks direct portable-plan coverage on exact source and destination identities", () => {
    const request = {
      requestId: "plan-request",
      source: sourceContext,
      destination,
      requestDigest: digest("d"),
    } as unknown as PortableContextPlanRequest;
    const result = {
      status: "ready" as const,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      plan: {
        planId: "plan-1",
        source: sourceContext,
        destination,
        messages: [{ messageId: "message-1", action: "include" as const, parts: [{ partIndex: 0, action: "include" as const }] }],
        context: sourceContext,
        requiresAcceptance: false,
        digest: digest("e"),
      },
    } as unknown as Extract<PortableContextPlanResult, { status: "ready" }>;
    expect(() => assertPortablePlanCoversRequest(request, result, [])).not.toThrow();
    expect(() => assertPortablePlanCoversRequest({ ...request, destination: { ...destination, runId: "other" } }, result, [])).toThrow();
  });
});
