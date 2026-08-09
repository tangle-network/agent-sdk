import {
  WorkspaceCheckpointLookupResultSchema,
  WorkspaceCleanupAcknowledgementSchema,
  WorkspaceForkLookupResultSchema,
  workspaceCleanupRequestDigest,
  workspaceCheckpointResultMatchesRequest,
  workspaceCleanupAcknowledgementMatches,
  workspaceForkResultMatchesRequest,
} from "@tangle-network/agent-interface";
import type {
  AgentWorkspaceBranching,
  WorkspaceCheckpointRequest,
  WorkspaceCheckpointRef,
  WorkspaceForkRequest,
} from "@tangle-network/agent-interface";
export async function cleanupWorkspaceResources(input: {
  operations: AgentWorkspaceBranching;
  checkpointRequest?: WorkspaceCheckpointRequest;
  checkpointRef?: WorkspaceCheckpointRef;
  forkRequest?: WorkspaceForkRequest;
  forkRef?: { environmentId: string; provider: string };
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (input.forkRequest) {
    try {
      const forkRef =
        input.forkRef ??
        (await recoverForkForCleanup(input.operations, input.forkRequest));
      if (forkRef !== undefined) {
        const request = {
          operationId: `${input.forkRequest.idempotencyKey}-cleanup`,
          kind: "fork" as const,
          targetId: forkRef.environmentId,
          provider: forkRef.provider,
          requestDigest: workspaceCleanupRequestDigest({
            kind: "fork",
            targetId: forkRef.environmentId,
            provider: forkRef.provider,
          }),
        };
        const acknowledgement = WorkspaceCleanupAcknowledgementSchema.parse(
          await input.operations.destroyFork(request),
        );
        if (!workspaceCleanupAcknowledgementMatches(request, acknowledgement)) {
          throw new Error(
            "fork cleanup did not confirm the exact target is absent",
          );
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (input.checkpointRequest) {
    try {
      const checkpointRef =
        input.checkpointRef ??
        (await recoverCheckpointForCleanup(
          input.operations,
          input.checkpointRequest,
        ));
      if (checkpointRef !== undefined) {
        const request = {
          operationId: `${input.checkpointRequest.idempotencyKey}-cleanup`,
          kind: "checkpoint" as const,
          targetId: checkpointRef.checkpointId,
          provider: checkpointRef.provider,
          requestDigest: workspaceCleanupRequestDigest({
            kind: "checkpoint",
            targetId: checkpointRef.checkpointId,
            provider: checkpointRef.provider,
          }),
        };
        const acknowledgement = WorkspaceCleanupAcknowledgementSchema.parse(
          await input.operations.deleteCheckpoint(request),
        );
        if (!workspaceCleanupAcknowledgementMatches(request, acknowledgement)) {
          throw new Error(
            "checkpoint cleanup did not confirm the exact target is absent",
          );
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function recoverCheckpointForCleanup(
  operations: AgentWorkspaceBranching,
  request: WorkspaceCheckpointRequest,
): Promise<WorkspaceCheckpointRef | undefined> {
  const result = WorkspaceCheckpointLookupResultSchema.parse(
    await operations.lookupCheckpoint({
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
    }),
  );
  if (result.status === "not_found") return undefined;
  if (
    result.status !== "found" ||
    !workspaceCheckpointResultMatchesRequest(request, result)
  ) {
    throw new Error(
      "checkpoint cleanup could not recover the exact remote result",
    );
  }
  return result.checkpoint;
}

async function recoverForkForCleanup(
  operations: AgentWorkspaceBranching,
  request: WorkspaceForkRequest,
): Promise<{ environmentId: string; provider: string } | undefined> {
  const result = WorkspaceForkLookupResultSchema.parse(
    await operations.lookupFork({
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
    }),
  );
  if (result.status === "not_found") return undefined;
  if (
    result.status !== "found" ||
    !workspaceForkResultMatchesRequest(request, result)
  ) {
    throw new Error("fork cleanup could not recover the exact remote result");
  }
  return result.environment;
}
