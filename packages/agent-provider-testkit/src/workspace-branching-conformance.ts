import {
  WorkspaceCheckpointLookupResultSchema,
  WorkspaceCheckpointResultSchema,
  WorkspaceCleanupAcknowledgementSchema,
  WorkspaceForkLookupResultSchema,
  WorkspaceForkResultSchema,
  workspaceCheckpointRequestDigest,
  workspaceCheckpointResultMatchesRequest,
  workspaceCleanupAcknowledgementMatches,
  workspaceCleanupRequestDigest,
  workspaceForkRequestDigest,
  workspaceForkResultMatchesRequest,
} from "@tangle-network/agent-interface";
import type {
  WorkspaceCheckpointRef,
  WorkspaceForkRequest,
} from "@tangle-network/agent-interface";
import type {
  WorkspaceBranchingConformanceOptions,
  WorkspaceBranchingConformanceReport,
} from "./conformance-types.js";
import { assert, deepEqual } from "./conformance-helpers.js";
import { cleanupWorkspaceResources } from "./workspace-cleanup-conformance.js";

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
      placement: forkRequest.placement,
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
      kind: "checkpoint" as const,
      targetId: createdCheckpoint.checkpoint.checkpointId,
      provider: createdCheckpoint.checkpoint.provider,
      requestDigest: workspaceCleanupRequestDigest({
        kind: "checkpoint",
        targetId: createdCheckpoint.checkpoint.checkpointId,
        provider: createdCheckpoint.checkpoint.provider,
      }),
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
      kind: "fork" as const,
      targetId: createdFork.environment.environmentId,
      provider: createdFork.environment.provider,
      requestDigest: workspaceCleanupRequestDigest({
        kind: "fork",
        targetId: createdFork.environment.environmentId,
        provider: createdFork.environment.provider,
      }),
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
    const changedForkCleanupRequest = {
      ...forkCleanupRequest,
      targetId: "different-fork-target",
      requestDigest: workspaceCleanupRequestDigest({
        kind: "fork",
        targetId: "different-fork-target",
        provider: forkCleanupRequest.provider,
      }),
    };
    const forkCleanupConflict = WorkspaceCleanupAcknowledgementSchema.parse(
      await options.operations.destroyFork(changedForkCleanupRequest),
    );
    assert(
      forkCleanupConflict.status === "conflict" &&
        forkCleanupConflict.existingRequestDigest ===
          forkCleanupRequest.requestDigest &&
        !workspaceCleanupAcknowledgementMatches(
          changedForkCleanupRequest,
          forkCleanupConflict,
        ),
      "changed fork cleanup input must conflict with the original operation",
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
    const changedCheckpointCleanupRequest = {
      ...checkpointCleanupRequest,
      targetId: "different-checkpoint-target",
      requestDigest: workspaceCleanupRequestDigest({
        kind: "checkpoint",
        targetId: "different-checkpoint-target",
        provider: checkpointCleanupRequest.provider,
      }),
    };
    const checkpointCleanupConflict = WorkspaceCleanupAcknowledgementSchema.parse(
      await options.operations.deleteCheckpoint(changedCheckpointCleanupRequest),
    );
    assert(
      checkpointCleanupConflict.status === "conflict" &&
        checkpointCleanupConflict.existingRequestDigest ===
          checkpointCleanupRequest.requestDigest &&
        !workspaceCleanupAcknowledgementMatches(
          changedCheckpointCleanupRequest,
          checkpointCleanupConflict,
        ),
      "changed checkpoint cleanup input must conflict with the original operation",
      checked,
    );
    checkpointCleanupConfirmed = true;
    checked.push("cleanup-operation-conflict", "confirmed-cleanup");

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
