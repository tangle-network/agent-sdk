import {
  AgentInteractiveSessionControlClaimAcknowledgementSchema,
  AgentInteractiveSessionControlClaimRequestSchema,
  AgentInteractiveSessionPromptAcknowledgementSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStopAcknowledgementSchema,
  agentInteractiveSessionControlClaimRequestDigest,
  agentInteractiveSessionRunRef,
  buildAgentExecutionPreparationReceipt,
  buildAgentWorkspaceLeaseRecord,
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  profileMaterializationRequests,
  type AgentExecutionPreparationReceipt,
  type AgentInteractiveSessionControlClaim,
  type AgentInteractiveSessionControlClaimRequest,
  type AgentInteractiveSessionControlClaimAcknowledgement,
  type AgentInteractiveSessionPromptAcknowledgement,
  type AgentInteractiveSessionPromptCommand,
  type AgentInteractiveSessionStopAcknowledgement,
  type AgentInteractiveSessionStopCommand,
  type AgentProfile,
} from "@tangle-network/agent-interface";
import { runInteractiveSessionConformance } from "@tangle-network/agent-provider-testkit";
import { describe, expect, it, vi } from "vitest";
import { createTangleInteractiveAgentRegistry } from "./tangle-interactive.js";
import type {
  SandboxInstanceLike,
  SandboxInteractiveSessionInfoLike,
  SandboxInteractiveSessionLike,
  SandboxInteractiveSessionStatusLike,
  SandboxTerminalHandlersLike,
  SandboxTerminalStreamLike,
} from "./tangle-types.js";

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;
const startedAt = "2026-08-16T00:00:00.000Z";
const endedAt = "2026-08-16T00:05:00.000Z";
const profile: AgentProfile = {
  name: "braid-test-agent",
  harness: "pi",
  model: {
    provider: "tangle-router",
    default: "zai/glm-5.2",
    reasoningEffort: "high",
  },
  prompt: { instructions: ["Fix the failing test."] },
};
const profileDigest = canonicalAgentProfileDigest(profile);
const startInput = {
  profile,
  requestedProfileDigest: profileDigest,
  initialPrompt: "Find and fix the failing test.",
  cwd: "/workspace",
  cols: 120,
  rows: 40,
} as const;
const coordinates = {
  provider: "tangle-sandbox",
  environmentId: "sandbox-1",
  sessionId: "session-1",
  executionId: "execution-1",
};
const run = agentInteractiveSessionRunRef(coordinates, startInput);
const preparationReceipt = preparationReceiptFor(run.requestDigest, profile);
const incarnationId = "interactive-incarnation-1";

function preparationReceiptFor(
  requestDigest: `sha256:${string}`,
  authoredProfile: AgentProfile,
): AgentExecutionPreparationReceipt {
  const sourceSnapshotPolicy = {
    kind: "provider-declared" as const,
    name: "tangle-sandbox/workspace",
    version: 1,
    digest: sha("7"),
  };
  const workspaceLease = buildAgentWorkspaceLeaseRecord({
    kind: "agent-workspace-lease" as const,
    schemaVersion: 1 as const,
    phase: "workspace-sealed" as const,
    leaseId: "sandbox-lease-1",
    ownerId: "tangle-sandbox",
    workspace: {
      provider: "tangle-sandbox",
      root: "/workspace",
      identityDigest: sha("2"),
    },
    isolation: "per-run" as const,
    sourceSnapshotDigest: sha("8"),
    sourceSnapshotPolicy,
    preparedWorkspaceDigest: sha("9"),
    profileActivationDigest: sha("3"),
    createdAtMs: 100,
    updatedAtMs: 200,
    expiresAtMs: 3_000,
    cleanupAttempts: 0,
  });
  const axisResults = profileMaterializationRequests(authoredProfile).map(
    ({ axis, path }) => ({
      axis,
      path,
      disposition: "behavior" as const,
      owner: "executor" as const,
      mechanism: "sandbox-profile-materializer",
    }),
  );
  return buildAgentExecutionPreparationReceipt({
    preparationId: "sandbox-preparation-1",
    requestDigest,
    authoredProfile,
    effectiveProfile: authoredProfile,
    backend: "tangle-router",
    harness: "pi",
    harnessVersion: "pi-1",
    resolvedModel: {
      requested: "zai/glm-5.2",
      resolved: "zai/glm-5.2",
      provider: "tangle-router",
      reasoningEffort: {
        requested: "high",
        resolved: "high",
        fidelity: "exact",
      },
    },
    workspaceLease,
    profileActivation: { digest: sha("3") },
    axisResults,
    executionPlanDigest: sha("4"),
    materializer: { name: "agent-profile-materialize", version: "0.15.3" },
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });
}

interface FakeInteractiveOptions {
  restored?: boolean;
}

function fakeInteractive(options: FakeInteractiveOptions = {}) {
  const refInfo: SandboxInteractiveSessionInfoLike = {
    sessionId: run.sessionId,
    harness: "pi",
    startedAt,
    streamUrl: `/terminals/${run.sessionId}/ws`,
    incarnationId,
    preparationReceipt,
  };
  let lifecycle: SandboxInteractiveSessionStatusLike = {
    state: "running",
    ...refInfo,
  };
  let currentGeneration = 0;
  let currentControl: AgentInteractiveSessionControlClaim | undefined;
  let starts = 0;
  const claimLedger = new Map<
    string,
    { requestDigest: `sha256:${string}`; acknowledgement: unknown }
  >();
  const promptLedger = new Map<
    string,
    { requestDigest: `sha256:${string}`; acknowledgement: unknown }
  >();
  const stopLedger = new Map<
    string,
    { requestDigest: `sha256:${string}`; acknowledgement: unknown }
  >();
  const writes: Array<string | Uint8Array> = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const attach = vi.fn(
    async (attachOptions: {
      control: AgentInteractiveSessionControlClaim;
      cols?: number;
      rows?: number;
      handlers?: SandboxTerminalHandlersLike;
    }): Promise<SandboxTerminalStreamLike> => {
      await validateControl(attachOptions.control);
      const ready = {
        connectionId: run.sessionId,
        sessionId: run.sessionId,
        restored: options.restored ?? true,
        detachTimeoutMs: 300_000,
      };
      let open = true;
      const stream: SandboxTerminalStreamLike = {
        connectionId: run.sessionId,
        ready,
        get isOpen() {
          return open;
        },
        write(data) {
          writes.push(data);
        },
        resize(cols, rows) {
          resizes.push({ cols, rows });
        },
        async close() {
          open = false;
          attachOptions.handlers?.onClose?.(1000, "detached");
        },
      };
      attachOptions.handlers?.onReady?.(ready);
      attachOptions.handlers?.onData?.(new TextEncoder().encode("Pi is ready.\r\n"));
      return stream;
    },
  );

  async function validateControl(control: AgentInteractiveSessionControlClaim): Promise<void> {
    if (
      currentControl === undefined ||
      canonicalCandidateDigest(currentControl) !== canonicalCandidateDigest(control) ||
      Date.parse(control.expiresAt) <= Date.now()
    ) {
      throw new Error("stale or expired interactive control");
    }
  }

  const start = vi.fn(
    async (request: Parameters<SandboxInteractiveSessionLike["start"]>[0]) => {
      if (request.requestDigest !== run.requestDigest) {
        throw new Error("interactive start operation conflict");
      }
      starts += starts === 0 ? 1 : 0;
      return refInfo;
    },
  );
  const claimControl = vi.fn(async (
    request: AgentInteractiveSessionControlClaimRequest,
  ): Promise<AgentInteractiveSessionControlClaimAcknowledgement> => {
    const previous = claimLedger.get(request.operationId);
    if (previous !== undefined) {
      if (previous.requestDigest !== request.requestDigest) {
        return {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          ref: request.ref,
          status: "conflict" as const,
          conflictReason: "operation_reuse" as const,
          currentGeneration,
          existingRequestDigest: previous.requestDigest,
        };
      }
      return AgentInteractiveSessionControlClaimAcknowledgementSchema.parse({
        ...(previous.acknowledgement as object),
        status: "replayed",
      });
    }
    if (request.expectedGeneration !== currentGeneration) {
      return {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        ref: request.ref,
        status: "conflict" as const,
        conflictReason: "generation_mismatch" as const,
        currentGeneration,
      };
    }
    currentGeneration += 1;
    currentControl = {
      refDigest: canonicalCandidateDigest(request.ref),
      generation: currentGeneration,
      leaseId: `interactive-lease-${currentGeneration}`,
      holderId: request.holderId,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const acknowledgement = {
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      ref: request.ref,
      status: "accepted" as const,
      control: currentControl,
    };
    claimLedger.set(request.operationId, {
      requestDigest: request.requestDigest,
      acknowledgement,
    });
    return AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(
      acknowledgement,
    );
  });
  const sendPrompt = vi.fn(async (
    command: AgentInteractiveSessionPromptCommand,
  ): Promise<AgentInteractiveSessionPromptAcknowledgement> => {
    await validateControl(command.control);
    const previous = promptLedger.get(command.operationId);
    if (previous !== undefined) {
      if (previous.requestDigest !== command.requestDigest) {
        return {
          operationId: command.operationId,
          requestDigest: command.requestDigest,
          ref: command.ref,
          control: command.control,
          status: "conflict" as const,
          existingRequestDigest: previous.requestDigest,
        };
      }
      return AgentInteractiveSessionPromptAcknowledgementSchema.parse({
        ...(previous.acknowledgement as object),
        status: "replayed",
      });
    }
    const acknowledgement: AgentInteractiveSessionPromptAcknowledgement = {
      operationId: command.operationId,
      requestDigest: command.requestDigest,
      ref: command.ref,
      control: command.control,
      status: "accepted",
    };
    promptLedger.set(command.operationId, {
      requestDigest: command.requestDigest,
      acknowledgement,
    });
    return AgentInteractiveSessionPromptAcknowledgementSchema.parse(
      acknowledgement,
    );
  });
  const stop = vi.fn(async (
    command: AgentInteractiveSessionStopCommand,
  ): Promise<AgentInteractiveSessionStopAcknowledgement> => {
    await validateControl(command.control);
    const previous = stopLedger.get(command.operationId);
    if (previous !== undefined) {
      if (previous.requestDigest !== command.requestDigest) {
        return {
          operationId: command.operationId,
          requestDigest: command.requestDigest,
          ref: command.ref,
          control: command.control,
          status: "conflict" as const,
          effect: "unknown" as const,
          existingRequestDigest: previous.requestDigest,
        };
      }
      return AgentInteractiveSessionStopAcknowledgementSchema.parse({
        ...(previous.acknowledgement as object),
        status: "replayed",
      });
    }
    lifecycle = {
      state: "exited",
      ...refInfo,
      endedAt,
      reason: "stopped",
      exitCode: 0,
    };
    const acknowledgement: AgentInteractiveSessionStopAcknowledgement = {
      operationId: command.operationId,
      requestDigest: command.requestDigest,
      ref: command.ref,
      control: command.control,
      status: "accepted",
      effect: "stopped",
    };
    stopLedger.set(command.operationId, {
      requestDigest: command.requestDigest,
      acknowledgement,
    });
    return AgentInteractiveSessionStopAcknowledgementSchema.parse(acknowledgement);
  });
  const handle: SandboxInteractiveSessionLike = {
    start,
    claimControl,
    status: vi.fn(async () => lifecycle),
    attach,
    validateControl,
    sendPrompt,
    stop,
  };
  const box: SandboxInstanceLike = {
    id: run.environmentId,
    status: "running",
    async *streamPrompt() {},
    session: (id) => ({
      id,
      interactive: () => handle,
      status: async () => null,
      async *events() {},
      result: async () => ({ success: true, status: "success", durationMs: 1 }),
      prompt: async () => ({ success: true, status: "success", durationMs: 1 }),
      interrupt: async () => ({ cancelled: false }),
    }),
    terminals: {
      get: vi.fn(async (sessionId) => ({
        sessionId,
        connectionId: sessionId,
        name: "Interactive pi",
        shell: "/bin/bash",
        command: "pi",
        cwd: "/workspace",
        cols: 120,
        rows: 40,
        createdAt: startedAt,
        lastActivityAt: startedAt,
        isRunning: true,
      })),
      attach: vi.fn(async () => {
        throw new Error("generic terminal attach must not be called");
      }),
    },
  };
  return { box, handle, attach, start, starts: () => starts, writes, resizes };
}

function request() {
  return { run, ...startInput };
}

function claimRequest(
  ref: ReturnType<typeof AgentInteractiveSessionRefSchema.parse>,
  operationId: string,
  holderId: string,
  expectedGeneration: number,
) {
  const material = { operationId, ref, holderId, expectedGeneration };
  return AgentInteractiveSessionControlClaimRequestSchema.parse({
    ...material,
    requestDigest: agentInteractiveSessionControlClaimRequestDigest(material),
  });
}

describe("Tangle exact interactive agent sessions", () => {
  it("passes the complete exact-session conformance suite", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId,
    );
    const report = await runInteractiveSessionConformance({
      name: "tangle-sandbox",
      request: request(),
      changedRequest: {
        ...request(),
        initialPrompt: "Run a different task.",
      },
      start: (value) => registry.start(value),
      interactive: (ref) => registry.get(ref),
      startCount: test.starts,
      prompt: "Return the word ok.",
      changedPrompt: "Perform a different paid action.",
    });

    expect(report.checked).toEqual(
      expect.arrayContaining([
        "claim-replay-after-lost-response",
        "stale-takeover-rejection",
        "claim-operation-conflict",
        "prompt-replay-after-lost-response",
        "stale-terminal-mutation-rejection",
        "stale-attach-rejection",
        "stale-stop-rejection",
        "start-replay-exited",
      ]),
    );
  });

  it("returns the server receipt and derives Sandbox creation identity from the exact run", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId,
    );
    const ref = await registry.start(request());

    expect(ref.preparationReceipt).toMatchObject({
      authoredProfileDigest: profileDigest,
      effectiveProfileDigest: profileDigest,
      backend: "tangle-router",
      harness: "pi",
      resolvedModel: {
        resolved: "zai/glm-5.2",
        reasoningEffort: { requested: "high", resolved: "high" },
      },
    });
    expect(test.start).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: run.runId,
        requestDigest: run.requestDigest,
      }),
    );
  });

  it("does not open a Sandbox terminal for a pre-aborted attach", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId,
    );
    const ref = await registry.start(request());
    const claim = await registry.get(ref).claimControl(
      claimRequest(ref, "claim", "coordinator", 0),
    );
    const exactClaim = AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(
      claim,
    ).control!;
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry.get(ref).attach(
        { control: exactClaim },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/i);
    expect(test.attach).not.toHaveBeenCalled();
  });
});
