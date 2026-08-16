import { describe, expect, it } from "vitest";
import type { AgentProfile, Sha256Digest } from "./index.js";
import {
  AgentInteractiveSessionControlClaimAcknowledgementSchema,
  AgentInteractiveSessionControlClaimRequestSchema,
  AgentInteractiveSessionPromptAcknowledgementSchema,
  AgentInteractiveSessionPromptCommandSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionAttachSchema,
  AgentInteractiveSessionStopAcknowledgementSchema,
  AgentInteractiveSessionStopCommandSchema,
  AgentInteractiveSessionStatusSchema,
  agentInteractiveSessionControlClaimAcknowledgementMatchesRequest,
  agentInteractiveSessionControlClaimRequestDigest,
  agentInteractiveSessionControlClaimIsNewer,
  agentInteractiveSessionControlClaimMatchesRef,
  agentInteractiveSessionPromptAcknowledgementMatchesCommand,
  agentInteractiveSessionPromptRequestDigest,
  agentInteractiveSessionStopAcknowledgementMatchesCommand,
  agentInteractiveSessionStopRequestDigest,
  agentInteractiveSessionRequestDigest,
  agentInteractiveSessionRefMatchesStart,
  agentInteractiveSessionRunRef,
  agentInteractiveSessionStatusMatchesRef,
  buildAgentExecutionPreparationReceipt,
  buildAgentWorkspaceLeaseRecord,
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  exactAgentInteractiveSessionStart,
  profileMaterializationRequests,
} from "./index.js";
import type { AgentExactRunControlRef } from "./runtime-control.js";

const sha = (digit: string): Sha256Digest =>
  `sha256:${digit.repeat(64)}` as Sha256Digest;

const runCoordinates = {
  provider: "tangle",
  environmentId: "sandbox-1",
  sessionId: "session-1",
  executionId: "execution-1",
};

const profile: AgentProfile = {
  name: "Braid product engineer",
  harness: "pi",
  model: {
    provider: "tangle-router",
    default: "zai/glm-5.2",
    reasoningEffort: "high",
  },
};

function preparationReceiptFor(
  authoredProfile: AgentProfile,
  effectiveProfile: AgentProfile = authoredProfile,
) {
  const sourceSnapshotPolicy = {
    kind: "provider-declared" as const,
    name: "agent-runtime/test-workspace-source",
    version: 1,
    digest: sha("7"),
  };
  const workspaceLease = buildAgentWorkspaceLeaseRecord({
    kind: "agent-workspace-lease" as const,
    schemaVersion: 1 as const,
    leaseId: "lease-1",
    ownerId: "braid-test-run",
    workspace: {
      provider: "agent-runtime/test-workspace",
      root: "/private/workspaces/braid-test",
      identityDigest: sha("2"),
    },
    isolation: "per-run" as const,
    sourceSnapshotDigest: sha("8"),
    sourceSnapshotPolicy,
    createdAtMs: 100,
    updatedAtMs: 200,
    expiresAtMs: 3_000,
    phase: "workspace-sealed" as const,
    preparedWorkspaceDigest: sha("9"),
    profileActivationDigest: sha("3"),
    cleanupAttempts: 0,
  });
  const axisResults = profileMaterializationRequests(authoredProfile).map(
    ({ axis, path }) => {
      const changed =
        (axis === "modelDefault" &&
          authoredProfile.model?.default !== effectiveProfile.model?.default) ||
        (axis === "modelReasoningEffort" &&
          authoredProfile.model?.reasoningEffort !==
            effectiveProfile.model?.reasoningEffort);
      return {
        axis,
        path,
        disposition: changed ? ("overridden" as const) : ("behavior" as const),
        owner: "executor" as const,
        mechanism: "prepared-profile",
        ...(changed ? { reason: "executor applied the admitted route" } : {}),
      };
    },
  );
  const requestedReasoningEffort =
    effectiveProfile.model?.reasoningEffort ??
    authoredProfile.model?.reasoningEffort ??
    "medium";
  return buildAgentExecutionPreparationReceipt({
    preparationId: "preparation-1",
    requestDigest: sha("1"),
    authoredProfile,
    effectiveProfile,
    backend: "cli-bridge",
    harness: "pi",
    harnessVersion: "0.99.0",
    resolvedModel: {
      requested: effectiveProfile.model?.default ?? "zai/glm-5.2",
      resolved: "zai/glm-5.2-2026-08-15",
      provider: effectiveProfile.model?.provider ?? "tangle-router",
      reasoningEffort: {
        requested: requestedReasoningEffort,
        resolved: requestedReasoningEffort,
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

const profileDigest = canonicalAgentProfileDigest(profile);
const preparationReceipt = preparationReceiptFor(profile);
const startInput = {
  profile,
  requestedProfileDigest: profileDigest,
  initialPrompt: "Inspect this workspace and report the test command.",
  cols: 120,
  rows: 40,
} as const;
const run: AgentExactRunControlRef = agentInteractiveSessionRunRef(
  runCoordinates,
  startInput,
);
const incarnationId = "interactive-7d404f31";
const startedAt = "2026-08-15T12:00:00.000Z";

function referenceFor(
  exactRun: AgentExactRunControlRef = run,
  receipt = preparationReceipt,
) {
  return AgentInteractiveSessionRefSchema.parse({
    run: exactRun,
    preparationReceipt: receipt,
    incarnationId,
    startedAt,
  });
}

function controlFor(ref: ReturnType<typeof referenceFor>, generation = 1) {
  return {
    refDigest: canonicalCandidateDigest(ref),
    generation,
    leaseId: `interactive-lease-${generation}`,
    holderId: "braid-coordinator-1",
    expiresAt: "2026-08-15T13:00:00.000Z",
  } as const;
}

describe("exact interactive agent session contract", () => {
  it("lets the caller start without admission and returns the canonical route", () => {
    expect("preparationReceipt" in startInput).toBe(false);
    const request = exactAgentInteractiveSessionStart({
      run,
      ...startInput,
    });
    const ref = referenceFor();
    const status = AgentInteractiveSessionStatusSchema.parse({
      state: "running",
      ref,
    });

    expect(agentInteractiveSessionRefMatchesStart(request, ref)).toBe(true);
    expect(agentInteractiveSessionStatusMatchesRef(ref, status)).toBe(true);
    expect(ref.preparationReceipt).toMatchObject({
      authoredProfileDigest: profileDigest,
      effectiveProfileDigest: profileDigest,
      backend: "cli-bridge",
      harness: "pi",
      harnessVersion: "0.99.0",
      resolvedModel: {
        requested: "zai/glm-5.2",
        resolved: "zai/glm-5.2-2026-08-15",
        provider: "tangle-router",
        reasoningEffort: {
          requested: "high",
          resolved: "high",
        fidelity: "exact",
        },
      },
    });
  });

  it("replays the same exact start without changing its run identity", () => {
    const first = exactAgentInteractiveSessionStart({
      run,
      ...startInput,
    });
    const replay = exactAgentInteractiveSessionStart({
      run,
      ...startInput,
    });
    const firstRef = referenceFor();
    const replayRef = referenceFor();

    expect(agentInteractiveSessionRequestDigest(runCoordinates, startInput)).toBe(
      run.requestDigest,
    );
    expect(agentInteractiveSessionRunRef(runCoordinates, startInput)).toEqual(run);
    expect(first).toEqual(replay);
    expect(firstRef).toEqual(replayRef);
    expect(firstRef.preparationReceipt).toEqual(replayRef.preparationReceipt);
    expect(firstRef.incarnationId).toBe(replayRef.incarnationId);
    expect(agentInteractiveSessionRefMatchesStart(replay, replayRef)).toBe(true);
  });

  it("changes the exact run when start material changes", () => {
    expect(
      agentInteractiveSessionRunRef(runCoordinates, {
        ...startInput,
        initialPrompt: "Run a different task.",
      }).requestDigest,
    ).not.toBe(run.requestDigest);
    expect(
      agentInteractiveSessionRunRef(
        { ...runCoordinates, executionId: "execution-2" },
        startInput,
      ).runId,
    ).not.toBe(run.runId);
  });

  it("rejects a profile or run identity that is not bound to the request", () => {
    expect(() =>
      exactAgentInteractiveSessionStart({
        run,
        profile: { ...profile, harness: undefined },
        requestedProfileDigest: canonicalAgentProfileDigest({
          ...profile,
          harness: undefined,
        }),
      }),
    ).toThrow(/AgentProfile\.harness/u);

    expect(() =>
      exactAgentInteractiveSessionStart({
        run,
        profile,
        requestedProfileDigest: sha("2"),
      }),
    ).toThrow(/profile digest/u);
  });

  it("rejects a random admitted digest instead of accepting a provider-private field", () => {
    expect(
      AgentInteractiveSessionRefSchema.safeParse({
        run,
        preparationReceipt,
        requestedProfileDigest: profileDigest,
        admittedProfileDigest: sha("b"),
        incarnationId,
        startedAt,
      }).success,
    ).toBe(false);
  });

  it("rejects a provider answer for another run, receipt, or incarnation", () => {
    const request = exactAgentInteractiveSessionStart({
      run,
      ...startInput,
    });
    const ref = referenceFor();

    expect(
      agentInteractiveSessionRefMatchesStart(request, {
        ...ref,
        run: { ...run, executionId: "execution-other" },
      }),
    ).toBe(false);
    expect(
      agentInteractiveSessionRefMatchesStart(request, {
        ...ref,
        preparationReceipt: {
          ...preparationReceipt,
          effectiveProfileDigest: sha("c"),
        },
      }),
    ).toBe(false);
    expect(
      agentInteractiveSessionStatusMatchesRef(ref, {
        state: "running",
        ref: { ...ref, incarnationId: "interactive-replacement" },
      }),
    ).toBe(false);
  });

  it("binds mutable operations to a separate provider-issued control generation", () => {
    const ref = referenceFor();
    const current = controlFor(ref, 1);
    const recovered = controlFor(ref, 2);
    const claimMaterial = {
      operationId: "control-operation-1",
      ref,
      holderId: "braid-coordinator-1",
      expectedGeneration: 0,
    };
    const claimRequest = {
      ...claimMaterial,
      requestDigest: agentInteractiveSessionControlClaimRequestDigest(
        claimMaterial,
      ),
    };
    const claimReplay = {
      operationId: claimRequest.operationId,
      requestDigest: claimRequest.requestDigest,
      ref,
      status: "replayed" as const,
      control: current,
    };
    const stopMaterial = {
      operationId: "stop-operation-1",
      ref,
      control: current,
    };
    const stopCommand = {
      ...stopMaterial,
      requestDigest: agentInteractiveSessionStopRequestDigest(stopMaterial),
    };

    expect(agentInteractiveSessionControlClaimMatchesRef(ref, current)).toBe(true);
    expect(agentInteractiveSessionControlClaimIsNewer(recovered, current)).toBe(true);
    expect(agentInteractiveSessionControlClaimIsNewer(current, recovered)).toBe(false);
    expect(
      agentInteractiveSessionControlClaimAcknowledgementMatchesRequest(
        claimRequest,
        claimReplay,
      ),
    ).toBe(true);
    expect(
      AgentInteractiveSessionControlClaimRequestSchema.safeParse(claimRequest)
        .success,
    ).toBe(true);
    expect(
      agentInteractiveSessionControlClaimMatchesRef(
        ref,
        { ...current, refDigest: sha("e") },
      ),
    ).toBe(false);
    expect(
      AgentInteractiveSessionAttachSchema.safeParse({
        cols: 120,
        rows: 40,
      }).success,
    ).toBe(false);
    expect(
      AgentInteractiveSessionStopCommandSchema.safeParse(stopCommand).success,
    ).toBe(true);
  });

  it("makes claim recovery replay-safe and distinguishes its two conflicts", () => {
    const ref = referenceFor();
    let currentGeneration = 0;
    const storedClaims = new Map<string, { digest: Sha256Digest; control: ReturnType<typeof controlFor> }>();

    const claim = (request: {
      operationId: string;
      ref: typeof ref;
      holderId: string;
      expectedGeneration: number;
      requestDigest: Sha256Digest;
    }) => {
      const stored = storedClaims.get(request.operationId);
      if (stored !== undefined) {
        if (stored.digest === request.requestDigest) {
          return AgentInteractiveSessionControlClaimAcknowledgementSchema.parse({
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            ref,
            status: "replayed",
            control: stored.control,
          });
        }
        return AgentInteractiveSessionControlClaimAcknowledgementSchema.parse({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          ref,
          status: "conflict",
          conflictReason: "operation_reuse",
          currentGeneration,
          existingRequestDigest: stored.digest,
        });
      }
      if (request.expectedGeneration !== currentGeneration) {
        return AgentInteractiveSessionControlClaimAcknowledgementSchema.parse({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          ref,
          status: "conflict",
          conflictReason: "generation_mismatch",
          currentGeneration,
        });
      }
      currentGeneration += 1;
      const control = controlFor(ref, currentGeneration);
      storedClaims.set(request.operationId, {
        digest: request.requestDigest,
        control,
      });
      return AgentInteractiveSessionControlClaimAcknowledgementSchema.parse({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        ref,
        status: "accepted",
        control,
      });
    };

    const firstMaterial = {
      operationId: "claim-recovery-1",
      ref,
      holderId: "braid-coordinator-1",
      expectedGeneration: 0,
    };
    const firstRequest = AgentInteractiveSessionControlClaimRequestSchema.parse({
      ...firstMaterial,
      requestDigest: agentInteractiveSessionControlClaimRequestDigest(firstMaterial),
    });
    const accepted = claim(firstRequest);
    const replayed = claim(firstRequest);

    expect(accepted.status).toBe("accepted");
    expect(replayed.status).toBe("replayed");
    expect(replayed.control).toEqual(accepted.control);
    expect(currentGeneration).toBe(1);

    const staleMaterial = {
      operationId: "claim-recovery-stale",
      ref,
      holderId: "recovered-coordinator",
      expectedGeneration: 0,
    };
    const staleRequest = AgentInteractiveSessionControlClaimRequestSchema.parse({
      ...staleMaterial,
      requestDigest: agentInteractiveSessionControlClaimRequestDigest(staleMaterial),
    });
    const staleConflict = claim(staleRequest);

    expect(staleConflict.status).toBe("conflict");
    expect(staleConflict.conflictReason).toBe("generation_mismatch");
    expect(staleConflict.currentGeneration).toBe(1);
    expect(staleConflict.existingRequestDigest).toBeUndefined();

    const changedMaterial = {
      ...firstMaterial,
      holderId: "different-coordinator",
    };
    const changedRequest = AgentInteractiveSessionControlClaimRequestSchema.parse({
      ...changedMaterial,
      requestDigest: agentInteractiveSessionControlClaimRequestDigest(changedMaterial),
    });
    const reuseConflict = claim(changedRequest);

    expect(reuseConflict.status).toBe("conflict");
    expect(reuseConflict.conflictReason).toBe("operation_reuse");
    expect(reuseConflict.currentGeneration).toBe(1);
    expect(reuseConflict.existingRequestDigest).toBe(firstRequest.requestDigest);

    expect(() =>
      AgentInteractiveSessionControlClaimAcknowledgementSchema.parse({
        ...staleConflict,
        conflictReason: "operation_reuse",
      }),
    ).toThrow(/operation reuse/u);
    expect(() =>
      AgentInteractiveSessionControlClaimAcknowledgementSchema.parse({
        ...reuseConflict,
        conflictReason: "generation_mismatch",
      }),
    ).toThrow(/generation mismatch/u);
  });

  it("rejects a caller-authored run identity that does not match the start", () => {
    expect(() =>
      exactAgentInteractiveSessionStart({
        run: {
          ...run,
          runId: "interactive-run-forged",
        },
        ...startInput,
      }),
    ).toThrow(/run identity/u);
    expect(() =>
      exactAgentInteractiveSessionStart({
        run,
        ...startInput,
        initialPrompt: "Changed after the run identity was minted.",
      }),
    ).toThrow(/run identity/u);
  });

  it("keeps process ids, commands, and environment data out of durable refs", () => {
    expect(
      AgentInteractiveSessionRefSchema.safeParse({
        ...referenceFor(),
        pid: 42,
      }).success,
    ).toBe(false);
    expect(
      AgentInteractiveSessionRefSchema.safeParse({
        ...referenceFor(),
        env: { API_KEY: "secret" },
      }).success,
    ).toBe(false);
  });

  it("uses one typed, replay-safe prompt command bound to the exact ref", () => {
    const ref = referenceFor();
    const control = controlFor(ref);
    const material = {
      operationId: "prompt-operation-1",
      ref,
      control,
      prompt: "Continue with the next test.",
    };
    const command = AgentInteractiveSessionPromptCommandSchema.parse({
      ...material,
      requestDigest: agentInteractiveSessionPromptRequestDigest(material),
    });
    const acknowledgement = AgentInteractiveSessionPromptAcknowledgementSchema.parse({
      operationId: command.operationId,
      requestDigest: command.requestDigest,
      ref,
      control,
      status: "accepted",
    });

    expect(agentInteractiveSessionPromptAcknowledgementMatchesCommand(
      command,
      acknowledgement,
    )).toBe(true);
    expect(
      AgentInteractiveSessionPromptCommandSchema.safeParse({
        ...command,
        prompt: "A paid duplicate action.",
      }).success,
    ).toBe(false);
    expect(
      agentInteractiveSessionPromptAcknowledgementMatchesCommand(command, {
        ...acknowledgement,
        ref: { ...ref, incarnationId: "interactive-replacement" },
      }),
    ).toBe(false);
  });

  it("models prompt replay, operation conflicts, and unknown outcomes explicitly", () => {
    const ref = referenceFor();
    const control = controlFor(ref);
    const command = {
      operationId: "prompt-operation-2",
      ref,
      control,
      prompt: "Inspect the changed file.",
      requestDigest: agentInteractiveSessionPromptRequestDigest({
        operationId: "prompt-operation-2",
        ref,
        control,
        prompt: "Inspect the changed file.",
      }),
    };
    const replayed = AgentInteractiveSessionPromptAcknowledgementSchema.parse({
      operationId: command.operationId,
      requestDigest: command.requestDigest,
      ref,
      control,
      status: "replayed",
    });
    const conflict = AgentInteractiveSessionPromptAcknowledgementSchema.parse({
      operationId: command.operationId,
      requestDigest: sha("d"),
      ref,
      control,
      status: "conflict",
      existingRequestDigest: command.requestDigest,
    });
    const unknown = AgentInteractiveSessionPromptAcknowledgementSchema.parse({
      operationId: command.operationId,
      requestDigest: command.requestDigest,
      ref,
      control,
      status: "unknown",
      message: "The transport lost the outcome.",
      retryable: true,
    });

    expect(agentInteractiveSessionPromptAcknowledgementMatchesCommand(
      command,
      replayed,
    )).toBe(true);
    expect(conflict.existingRequestDigest).toBe(command.requestDigest);
    expect(unknown.retryable).toBe(true);
    expect(
      agentInteractiveSessionPromptRequestDigest({
        operationId: command.operationId,
        ref: command.ref,
        control: controlFor(ref, 2),
        prompt: command.prompt,
      }),
    ).not.toBe(command.requestDigest);
    expect(() =>
      AgentInteractiveSessionPromptAcknowledgementSchema.parse({
        ...unknown,
        retryable: false,
      }),
      ).toThrow(/safe same-operation retry/u);
  });

  it("makes stop a replay-safe control-bound mutation", () => {
    const ref = referenceFor();
    const control = controlFor(ref);
    const material = {
      operationId: "stop-operation-2",
      ref,
      control,
    };
    const command = AgentInteractiveSessionStopCommandSchema.parse({
      ...material,
      requestDigest: agentInteractiveSessionStopRequestDigest(material),
    });
    const acknowledged = AgentInteractiveSessionStopAcknowledgementSchema.parse({
      operationId: command.operationId,
      requestDigest: command.requestDigest,
      ref,
      control,
      status: "accepted",
      effect: "stop_requested",
    });
    const replayed = AgentInteractiveSessionStopAcknowledgementSchema.parse({
      ...acknowledged,
      status: "replayed",
      effect: "stopped",
    });

    expect(
      agentInteractiveSessionStopAcknowledgementMatchesCommand(
        command,
        acknowledged,
      ),
    ).toBe(true);
    expect(
      agentInteractiveSessionStopAcknowledgementMatchesCommand(command, replayed),
    ).toBe(true);
    expect(
      AgentInteractiveSessionStopCommandSchema.safeParse({
        operationId: command.operationId,
        ref,
      }).success,
    ).toBe(false);
  });

  it("keeps requested and effective profile route facts together for Braid", () => {
    const effectiveProfile = {
      ...profile,
      model: {
        ...profile.model,
        default: "zai/glm-5.2-fast",
        reasoningEffort: "medium" as const,
      },
    };
    const receipt = preparationReceiptFor(profile, effectiveProfile);
    const effectiveRef = AgentInteractiveSessionRefSchema.parse({
      run,
      preparationReceipt: receipt,
      incarnationId,
      startedAt,
    });

    expect(effectiveRef.preparationReceipt).toMatchObject({
      authoredProfileDigest: profileDigest,
      effectiveProfileDigest: canonicalAgentProfileDigest(effectiveProfile),
      backend: "cli-bridge",
      harness: "pi",
      resolvedModel: {
        requested: "zai/glm-5.2-fast",
        reasoningEffort: {
          requested: "medium",
          resolved: "medium",
          fidelity: "exact",
        },
      },
    });
  });
});
