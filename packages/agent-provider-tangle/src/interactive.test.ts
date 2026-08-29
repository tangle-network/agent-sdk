import {
  AgentInteractiveSessionControlClaimAcknowledgementSchema,
  AgentInteractiveSessionControlClaimSchema,
  AgentInteractiveSessionControlClaimRequestSchema,
  AgentInteractiveSessionPromptAcknowledgementSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStopAcknowledgementSchema,
  AgentInteractiveSessionStopCommandSchema,
  agentInteractiveSessionControlClaimRequestDigest,
  agentInteractiveSessionStopRequestDigest,
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
  type AgentInteractiveSessionRef,
  type AgentInteractiveSessionStatus,
  type AgentInteractiveTerminalSession,
  type AgentProfile,
} from "@tangle-network/agent-interface";
import { runInteractiveSessionConformance } from "@tangle-network/agent-provider-testkit";
import { Sandbox, SandboxInstance } from "@tangle-network/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
  createTangleInteractiveAgentRegistry,
  sandboxBacksInteractiveAgent,
} from "./tangle-interactive.js";
import type {
  SandboxInstanceLike,
  SandboxInteractiveSessionLike,
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
  authoredProfile: AgentProfile
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
    })
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

function fakeInteractive() {
  const ref = AgentInteractiveSessionRefSchema.parse({
    run,
    preparationReceipt,
    incarnationId,
    startedAt,
  });
  let currentGeneration = 1;
  let currentControl = AgentInteractiveSessionControlClaimSchema.parse({
    refDigest: canonicalCandidateDigest(ref),
    generation: currentGeneration,
    leaseId: "interactive-lease-1",
    holderId: "tangle-sidecar",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  let lifecycle: AgentInteractiveSessionStatus = { state: "running", ref };
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

  const validateControl = vi.fn(
    async (
      control: AgentInteractiveSessionControlClaim,
      options?: { signal?: AbortSignal }
    ): Promise<void> => {
      options?.signal?.throwIfAborted();
      if (
        canonicalCandidateDigest(currentControl) !==
          canonicalCandidateDigest(control) ||
        Date.parse(control.expiresAt) <= Date.now()
      ) {
        throw new Error("stale or expired interactive control");
      }
    }
  );

  const attachAgentTerminal = vi.fn(
    async (
      attachRequest: Parameters<
        SandboxInteractiveSessionLike["attachAgentTerminal"]
      >[0],
      options?: { signal?: AbortSignal }
    ): Promise<AgentInteractiveTerminalSession> => {
      await validateControl(attachRequest.control, options);
      let detached = false;
      return {
        ref: {
          terminalSessionId: run.sessionId,
          parentExecutionId: run.executionId,
          name: "interactive-pi",
          shell: "/bin/bash",
          command: "pi",
          cwd: "/workspace",
          cols: attachRequest.cols ?? 120,
          rows: attachRequest.rows ?? 40,
          connectionId: run.sessionId,
          createdAt: startedAt,
          lastActivityAt: startedAt,
          expiresAt: attachRequest.control.expiresAt,
          isRunning: true,
          attachCount: 1,
        },
        cursors: { earliest: 0, latest: 0 },
        control: attachRequest.control,
        async input(input, operation) {
          operation?.signal?.throwIfAborted();
          if (detached) throw new Error("terminal is detached");
          writes.push(input.data);
        },
        async resize(resize, operation) {
          operation?.signal?.throwIfAborted();
          if (detached) throw new Error("terminal is detached");
          resizes.push(resize);
        },
        async detach(operation) {
          operation?.signal?.throwIfAborted();
          detached = true;
          return {
            status: "detached" as const,
            terminalSessionId: run.sessionId,
            connectionId: run.sessionId,
          };
        },
        async close(operation) {
          operation?.signal?.throwIfAborted();
          detached = true;
          return {
            status: "unknown" as const,
            terminalSessionId: run.sessionId,
            message: "The terminal detached without stopping the agent.",
            retryable: false,
          };
        },
        async *events() {
          yield { type: "ready" as const };
        },
      };
    }
  );

  const start = vi.fn(
    async (
      startRequest: Parameters<SandboxInteractiveSessionLike["start"]>[0],
      options?: { signal?: AbortSignal }
    ) => {
      options?.signal?.throwIfAborted();
      if (
        canonicalCandidateDigest(startRequest) !==
        canonicalCandidateDigest({ run, ...startInput })
      ) {
        throw new Error("interactive start operation conflict");
      }
      starts += starts === 0 ? 1 : 0;
      if (lifecycle.state === "running") {
        return {
          state: "running" as const,
          ref: lifecycle.ref,
          control: currentControl,
          streamUrl: `/terminals/${run.sessionId}/ws`,
        };
      }
      if (lifecycle.state === "unknown") {
        throw new Error("interactive session state is unknown");
      }
      return {
        state: "exited" as const,
        ref: lifecycle.ref,
        control: currentControl,
        endedAt: lifecycle.endedAt,
        reason: lifecycle.reason,
        ...(lifecycle.exitCode === undefined
          ? {}
          : { exitCode: lifecycle.exitCode }),
        ...(lifecycle.exitSignal === undefined
          ? {}
          : { exitSignal: lifecycle.exitSignal }),
      };
    }
  );
  const claimControl = vi.fn(
    async (
      request: AgentInteractiveSessionControlClaimRequest
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
      currentControl = AgentInteractiveSessionControlClaimSchema.parse({
        refDigest: canonicalCandidateDigest(request.ref),
        generation: currentGeneration,
        leaseId: `interactive-lease-${currentGeneration}`,
        holderId: request.holderId,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
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
        acknowledgement
      );
    }
  );
  const sendPrompt = vi.fn(
    async (
      command: AgentInteractiveSessionPromptCommand
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
        acknowledgement
      );
    }
  );
  const stop = vi.fn(
    async (
      command: AgentInteractiveSessionStopCommand
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
        ref,
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
      return AgentInteractiveSessionStopAcknowledgementSchema.parse(
        acknowledgement
      );
    }
  );
  const handle: SandboxInteractiveSessionLike = {
    start,
    claimControl,
    status: vi.fn(async () => lifecycle),
    attachAgentTerminal,
    validateControl,
    sendPrompt,
    stop,
  };
  const interactive = vi.fn(
    (_options?: {
      ref?: AgentInteractiveSessionRef;
      control?: AgentInteractiveSessionControlClaim;
    }) => handle
  );
  const box: SandboxInstanceLike = {
    id: run.environmentId,
    status: "running",
    async *streamPrompt() {},
    session: (id) => ({
      id,
      interactive,
      status: async () => null,
      async *events() {},
      result: async () => ({ success: true, status: "success", durationMs: 1 }),
      prompt: async () => ({ success: true, status: "success", durationMs: 1 }),
      interrupt: async () => ({ cancelled: false }),
    }),
  };
  const replaceProcessIdentity = (
    identity: Partial<AgentInteractiveSessionRef>
  ) => {
    lifecycle = { state: "running", ref: { ...ref, ...identity } };
  };
  const replaceControlExpiration = (expiresAt: string) => {
    currentControl = AgentInteractiveSessionControlClaimSchema.parse({
      ...currentControl,
      expiresAt,
    });
  };
  return {
    box,
    handle,
    interactive,
    attach: attachAgentTerminal,
    claimControl,
    replaceControlExpiration,
    replaceProcessIdentity,
    start,
    starts: () => starts,
    writes,
    resizes,
  };
}

function request() {
  return { run, ...startInput };
}

function claimRequest(
  ref: ReturnType<typeof AgentInteractiveSessionRefSchema.parse>,
  operationId: string,
  holderId: string,
  expectedGeneration: number
) {
  const material = { operationId, ref, holderId, expectedGeneration };
  return AgentInteractiveSessionControlClaimRequestSchema.parse({
    ...material,
    requestDigest: agentInteractiveSessionControlClaimRequestDigest(material),
  });
}

describe("Tangle exact interactive agent sessions", () => {
  it("matches the exact interactive handle surface in the linked Sandbox SDK", () => {
    const client = new Sandbox({
      baseUrl: "https://sandbox.tangle.tools",
      apiKey: "surface-probe-only",
    });
    const box = new SandboxInstance(client, {
      id: "surface-probe",
      status: "stopped",
      createdAt: new Date(0),
    });

    const handle = box.session("__tangle-interactive-probe__").interactive();
    const requiredMethods = [
      "start",
      "claimControl",
      "status",
      "attachAgentTerminal",
      "validateControl",
      "sendPrompt",
      "stop",
    ];
    const hasExactSurface = requiredMethods.every(
      (method) =>
        typeof (handle as unknown as Record<string, unknown>)[method] ===
        "function"
    );
    expect(
      sandboxBacksInteractiveAgent(box as unknown as SandboxInstanceLike)
    ).toBe(hasExactSurface);
  });

  it("passes the complete exact-session conformance suite", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId
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
      initialControlGeneration: 1,
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
      ])
    );
  });

  it("returns the server receipt and forwards the exact start request", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId
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
        run,
        profile,
      }),
      undefined
    );
  });

  it("replays an exited session after its write lease expires", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId
    );
    const ref = await registry.start(request());
    const session = registry.get(ref);
    const claim = await session.claimControl(
      claimRequest(ref, "claim-before-exit", "coordinator", 1)
    );
    if (claim.status !== "accepted" || claim.control === undefined) {
      throw new Error("control claim setup failed");
    }
    const stopMaterial = {
      operationId: "stop-before-expiry",
      ref,
      control: claim.control,
    };
    await session.stop(
      AgentInteractiveSessionStopCommandSchema.parse({
        ...stopMaterial,
        requestDigest: agentInteractiveSessionStopRequestDigest(stopMaterial),
      })
    );
    test.replaceControlExpiration("2020-01-01T00:00:00.000Z");

    await expect(registry.start(request())).resolves.toEqual(ref);
  });

  it("reconstructs a mutation handle with the persisted control claim", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId
    );
    const ref = await registry.start(request());
    const claim = await registry
      .get(ref)
      .claimControl(
        claimRequest(ref, "claim-before-restart", "coordinator", 1)
      );
    if (claim.status !== "accepted" || claim.control === undefined) {
      throw new Error("control claim setup failed");
    }

    const terminal = await registry.get(ref).attach({ control: claim.control });
    await terminal.detach();

    expect(test.interactive).toHaveBeenCalledWith({
      ref,
      control: claim.control,
    });
  });

  it("rejects every complete reference mismatch before reaching Sandbox", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId
    );
    const ref = await registry.start(request());
    const changedReceiptMaterial = {
      ...ref.preparationReceipt,
      harnessVersion: "pi-2",
    };
    const { digest: _digest, ...changedReceiptWithoutDigest } =
      changedReceiptMaterial;
    const changedReceipt = {
      ...changedReceiptMaterial,
      digest: canonicalCandidateDigest(changedReceiptWithoutDigest),
    };
    const variants: Array<[string, AgentInteractiveSessionRef]> = [
      ["provider", { ...ref, run: { ...ref.run, provider: "other-provider" } }],
      [
        "environment",
        { ...ref, run: { ...ref.run, environmentId: "other-environment" } },
      ],
      ["session", { ...ref, run: { ...ref.run, sessionId: "other-session" } }],
      [
        "execution",
        { ...ref, run: { ...ref.run, executionId: "other-execution" } },
      ],
      ["run", { ...ref, run: { ...ref.run, runId: "other-run" } }],
      ["request", { ...ref, run: { ...ref.run, requestDigest: sha("f") } }],
      ["preparation receipt", { ...ref, preparationReceipt: changedReceipt }],
      ["incarnation", { ...ref, incarnationId: "other-incarnation" }],
      ["start time", { ...ref, startedAt: "2026-08-16T00:01:00.000Z" }],
    ];
    const session = registry.get(ref);
    for (const [label, changedRef] of variants) {
      const before = test.claimControl.mock.calls.length;
      await expect(
        session.claimControl(
          claimRequest(changedRef, `mismatch-${label}`, "coordinator", 1)
        )
      ).rejects.toThrow(/different interactive session ref/);
      expect(test.claimControl).toHaveBeenCalledTimes(before);
    }
  });

  it("fails closed when Sandbox reports a replacement process", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId
    );
    const ref = await registry.start(request());

    test.replaceProcessIdentity({ incarnationId: "interactive-incarnation-2" });

    await expect(registry.get(ref).status()).rejects.toThrow(
      /different interactive agent session identity/
    );
  });

  it("does not open a Sandbox terminal for a pre-aborted attach", async () => {
    const test = fakeInteractive();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      coordinates.provider,
      coordinates.environmentId
    );
    const ref = await registry.start(request());
    const claim = await registry
      .get(ref)
      .claimControl(claimRequest(ref, "claim", "coordinator", 1));
    const exactClaim =
      AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(claim)
        .control!;
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry
        .get(ref)
        .attach({ control: exactClaim }, { signal: controller.signal })
    ).rejects.toThrow(/aborted/i);
    expect(test.attach).not.toHaveBeenCalled();
  });
});
