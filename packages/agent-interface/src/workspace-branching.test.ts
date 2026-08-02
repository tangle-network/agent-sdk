import { describe, expect, it } from "vitest";
import {
  ForkedEnvironmentRefSchema,
  WorkspaceCheckpointLookupResultSchema,
  WorkspaceCheckpointRefSchema,
  WorkspaceCheckpointRequestSchema,
  WorkspaceCheckpointResultSchema,
  WorkspaceCleanupAcknowledgementSchema,
  WorkspaceForkLookupResultSchema,
  WorkspaceForkRequestSchema,
  WorkspaceForkResultSchema,
  workspaceCheckpointRequestDigest,
  workspaceCheckpointResultMatchesRequest,
  workspaceCleanupAcknowledgementMatches,
  workspaceForkRequestDigest,
  workspaceForkResultMatchesRequest,
  type WorkspaceCheckpointRef,
} from "./workspace-branching.js";

const source = {
  runId: "run-1",
  provider: "tangle",
  environmentId: "environment-source",
  sessionId: "session-1",
};

const checkpointMaterial = {
  source,
  name: "branch boundary",
  metadata: { messageId: "message-4" },
};

const checkpointRequest = {
  ...checkpointMaterial,
  idempotencyKey: "checkpoint-operation-1",
  requestDigest: workspaceCheckpointRequestDigest(checkpointMaterial),
};

const checkpoint: WorkspaceCheckpointRef = {
  checkpointId: "checkpoint-1",
  provider: "tangle",
  source,
  idempotencyKey: checkpointRequest.idempotencyKey,
  requestDigest: checkpointRequest.requestDigest,
  createdAt: "2026-08-01T20:00:00.000Z",
  metadata: checkpointMaterial.metadata,
};

describe("retry-safe workspace checkpoint", () => {
  it("binds idempotency key to the canonical request material", () => {
    expect(WorkspaceCheckpointRequestSchema.parse(checkpointRequest)).toEqual(
      checkpointRequest,
    );
    expect(() =>
      WorkspaceCheckpointRequestSchema.parse({
        ...checkpointRequest,
        name: "changed",
      }),
    ).toThrow(/digest/);
    expect(WorkspaceCheckpointRefSchema.parse(checkpoint)).toEqual(checkpoint);
  });

  it("validates create, replay, conflict, unknown, and lookup outcomes", () => {
    for (const status of ["created", "replayed"] as const) {
      expect(
        WorkspaceCheckpointResultSchema.parse({
          status,
          idempotencyKey: checkpointRequest.idempotencyKey,
          requestDigest: checkpointRequest.requestDigest,
          checkpoint,
        }),
      ).toMatchObject({ status });
    }
    expect(() =>
      WorkspaceCheckpointResultSchema.parse({
        status: "created",
        idempotencyKey: "wrong-operation",
        requestDigest: checkpointRequest.requestDigest,
        checkpoint,
      }),
    ).toThrow(/identity/);
    expect(
      WorkspaceCheckpointResultSchema.parse({
        status: "conflict",
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
        existingRequestDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(
      WorkspaceCheckpointResultSchema.parse({
        status: "unknown",
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
        message: "remote outcome unavailable",
        retryable: false,
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      WorkspaceCheckpointLookupResultSchema.parse({
        status: "found",
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
        checkpoint,
      }),
    ).toMatchObject({ status: "found" });
    expect(
      workspaceCheckpointResultMatchesRequest(checkpointRequest, {
        status: "found",
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
        checkpoint,
      }),
    ).toBe(true);
    expect(
      workspaceCheckpointResultMatchesRequest(
        { ...checkpointRequest, name: "changed without a new digest" },
        {
          status: "found",
          idempotencyKey: checkpointRequest.idempotencyKey,
          requestDigest: checkpointRequest.requestDigest,
          checkpoint,
        },
      ),
    ).toBe(false);
    expect(
      workspaceCheckpointResultMatchesRequest(checkpointRequest, {
        status: "found",
        idempotencyKey: checkpointRequest.idempotencyKey,
        requestDigest: checkpointRequest.requestDigest,
        checkpoint: { ...checkpoint, createdAt: "not-a-timestamp" },
      }),
    ).toBe(false);
  });
});

describe("retry-safe environment fork", () => {
  const forkMaterial = {
    checkpoint,
    name: "branch destination",
    metadata: { branchId: "branch-2" },
  };
  const request = {
    ...forkMaterial,
    idempotencyKey: "fork-operation-1",
    requestDigest: workspaceForkRequestDigest(forkMaterial),
  };
  const environment = {
    provider: "tangle",
    environmentId: "environment-destination",
    sourceCheckpointId: checkpoint.checkpointId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    createdAt: "2026-08-01T20:00:01.000Z",
    placement: { kind: "sandbox" as const, sandboxId: "sandbox-2", region: "us-west" },
    confidential: true,
    metadata: forkMaterial.metadata,
  };

  it("binds the source checkpoint and destination request digest", () => {
    expect(WorkspaceForkRequestSchema.parse(request)).toEqual(request);
    expect(ForkedEnvironmentRefSchema.parse(environment)).toEqual(environment);
    expect(() =>
      WorkspaceForkRequestSchema.parse({ ...request, name: "changed" }),
    ).toThrow(/digest/);
  });

  it("validates create, replay, conflict, unknown, and lookup outcomes", () => {
    for (const status of ["created", "replayed"] as const) {
      expect(
        WorkspaceForkResultSchema.parse({
          status,
          idempotencyKey: request.idempotencyKey,
          requestDigest: request.requestDigest,
          environment,
        }),
      ).toMatchObject({ status });
    }
    expect(() =>
      WorkspaceForkResultSchema.parse({
        status: "created",
        idempotencyKey: "wrong-operation",
        requestDigest: request.requestDigest,
        environment,
      }),
    ).toThrow(/identity/);
    expect(
      WorkspaceForkResultSchema.parse({
        status: "conflict",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        existingRequestDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(
      WorkspaceForkResultSchema.parse({
        status: "unknown",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        message: "remote outcome unavailable",
        retryable: false,
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      WorkspaceForkLookupResultSchema.parse({
        status: "found",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        environment,
      }),
    ).toMatchObject({ status: "found" });
    expect(
      workspaceForkResultMatchesRequest(request, {
        status: "found",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        environment,
      }),
    ).toBe(true);
    expect(
      workspaceForkResultMatchesRequest(
        { ...request, name: "changed without a new digest" },
        {
          status: "found",
          idempotencyKey: request.idempotencyKey,
          requestDigest: request.requestDigest,
          environment,
        },
      ),
    ).toBe(false);
    expect(
      workspaceForkResultMatchesRequest(request, {
        status: "found",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        environment: { ...environment, createdAt: "not-a-timestamp" },
      }),
    ).toBe(false);
    expect(
      workspaceForkResultMatchesRequest(request, {
        status: "created",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        environment: {
          ...environment,
          metadata: { branchId: "wrong-branch" },
        },
      }),
    ).toBe(false);
  });
});

describe("workspace cleanup acknowledgement", () => {
  it.each([
    "deleted",
    "already_absent",
    "unknown",
    "in_use",
    "conflict",
    "transport_failure",
  ] as const)(
    "validates %s",
    (status) => {
      const request = {
        operationId: "cleanup-1",
        targetId: "checkpoint-1",
        provider: "tangle",
      };
      const acknowledgement = WorkspaceCleanupAcknowledgementSchema.parse({
        ...request,
        status,
        ...(["unknown", "in_use", "conflict", "transport_failure"].includes(status)
          ? {
              message: "remote cleanup outcome",
              ...(status === "in_use"
                ? { blockingTargetIds: ["environment-fork-1"] }
                : {}),
              ...(["unknown", "transport_failure"].includes(status)
                ? { retryable: true }
                : {}),
            }
          : {}),
      });
      expect(acknowledgement).toMatchObject({ status });
      expect(
        workspaceCleanupAcknowledgementMatches(request, acknowledgement),
      ).toBe(status === "deleted" || status === "already_absent");
    },
  );

  it("requires machine-readable blockers when a checkpoint remains in use", () => {
    expect(() =>
      WorkspaceCleanupAcknowledgementSchema.parse({
        operationId: "cleanup-1",
        targetId: "checkpoint-1",
        provider: "tangle",
        status: "in_use",
        message: "a fork still depends on this checkpoint",
      }),
    ).toThrow(/blocking target/);
  });

  it.each(["unknown", "transport_failure"] as const)(
    "requires explicit retry safety for %s",
    (status) => {
      expect(() =>
        WorkspaceCleanupAcknowledgementSchema.parse({
          operationId: "cleanup-1",
          targetId: "checkpoint-1",
          provider: "tangle",
          status,
          message: "remote cleanup outcome",
        }),
      ).toThrow(/retry is safe/);
    },
  );

  it("rejects malformed requests before matching acknowledgements", () => {
    expect(
      workspaceCleanupAcknowledgementMatches(
        { operationId: "", targetId: "checkpoint-1", provider: "tangle" },
        {
          operationId: "",
          targetId: "checkpoint-1",
          provider: "tangle",
          status: "deleted",
        },
      ),
    ).toBe(false);
  });
});
