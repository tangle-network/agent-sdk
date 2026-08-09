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
  workspaceCleanupRequestDigest,
  workspaceForkRequestDigest,
  workspaceForkResultMatchesRequest,
  forkedEnvironmentConfidentialityVerified,
  type WorkspaceCheckpointRef,
} from "./workspace-branching.js";

const source = {
  runId: "run-1",
  provider: "tangle",
  environmentId: "environment-source",
  sessionId: "session-1",
  executionId: "execution-1",
  requestDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
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
    placement: { kind: "sandbox" as const, sandboxId: "sandbox-2", region: "us-west" },
  };
  const request = {
    ...forkMaterial,
    idempotencyKey: "fork-operation-1",
    requestDigest: workspaceForkRequestDigest(forkMaterial),
  };
  const environment = {
    provider: "tangle",
    environmentId: "environment-destination",
    sourceEnvironmentId: source.environmentId,
    source,
    sourceCheckpointId: checkpoint.checkpointId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    createdAt: "2026-08-01T20:00:01.000Z",
    placement: forkMaterial.placement,
    confidentialRequested: false,
    confidential: false,
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
    expect(
      workspaceForkResultMatchesRequest(request, {
        status: "found",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        environment: {
          ...environment,
          environmentId: checkpoint.source.environmentId,
        },
      }),
    ).toBe(false);
    const confidentialMaterial = {
      ...forkMaterial,
      confidential: {
        requested: true,
        nonce: "nonce-1",
        policy: "policy-1",
        profileDigest: checkpoint.requestDigest,
      },
    };
    const confidentialRequest = {
      ...confidentialMaterial,
      idempotencyKey: "fork-confidential",
      requestDigest: workspaceForkRequestDigest(confidentialMaterial),
    };
    expect(
      forkedEnvironmentConfidentialityVerified(confidentialRequest, {
        ...environment,
        confidentialRequested: true,
        requestDigest: confidentialRequest.requestDigest,
        confidential: true,
      }),
    ).toBe(false);
    const attestation = {
      provider: "tangle",
      requested: true as const,
      nonce: "nonce-1",
      measurement: `sha256:${"4".repeat(64)}` as const,
      environmentId: environment.environmentId,
      source,
      requestDigest: confidentialRequest.requestDigest,
      profileDigest: checkpoint.requestDigest,
      policy: "policy-1",
      quote: "quote-1",
      providerKeyId: "tangle-key-1",
      providerSignature: "signature-1",
      verifiedAt: "2026-08-01T20:00:02.000Z",
    };
    expect(
      forkedEnvironmentConfidentialityVerified(confidentialRequest, {
        ...environment,
        confidentialRequested: true,
        confidential: false,
        requestDigest: confidentialRequest.requestDigest,
        confidentialAttestation: attestation,
      }, () => true),
    ).toBe(true);
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
        kind: "checkpoint" as const,
        targetId: "checkpoint-1",
        provider: "tangle",
        requestDigest: workspaceCleanupRequestDigest({
          kind: "checkpoint",
          targetId: "checkpoint-1",
          provider: "tangle",
        }),
      };
      const acknowledgement = WorkspaceCleanupAcknowledgementSchema.parse({
        ...request,
        status,
        ...(["unknown", "in_use", "conflict", "transport_failure"].includes(status)
          ? {
              message: "remote cleanup outcome",
              ...(status === "conflict"
                ? { existingRequestDigest: `sha256:${"f".repeat(64)}` }
                : {}),
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
        kind: "checkpoint",
        targetId: "checkpoint-1",
        provider: "tangle",
        requestDigest: workspaceCleanupRequestDigest({
          kind: "checkpoint",
          targetId: "checkpoint-1",
          provider: "tangle",
        }),
        status: "in_use",
        message: "a fork still depends on this checkpoint",
      }),
    ).toThrow(/blocking target/);
  });

  it("requires a distinct existing digest for cleanup conflicts", () => {
    const request = {
      operationId: "cleanup-1",
      kind: "checkpoint" as const,
      targetId: "checkpoint-1",
      provider: "tangle",
      requestDigest: workspaceCleanupRequestDigest({
        kind: "checkpoint",
        targetId: "checkpoint-1",
        provider: "tangle",
      }),
    };
    for (const existingRequestDigest of [undefined, request.requestDigest]) {
      expect(() =>
        WorkspaceCleanupAcknowledgementSchema.parse({
          ...request,
          status: "conflict",
          message: "cleanup operation was reused with different input",
          ...(existingRequestDigest === undefined
            ? {}
            : { existingRequestDigest }),
        }),
      ).toThrow(/existing digest|different request/);
    }
  });

  it.each(["unknown", "transport_failure"] as const)(
    "requires explicit retry safety for %s",
    (status) => {
      expect(() =>
        WorkspaceCleanupAcknowledgementSchema.parse({
          operationId: "cleanup-1",
          kind: "checkpoint",
          targetId: "checkpoint-1",
          provider: "tangle",
          requestDigest: workspaceCleanupRequestDigest({
            kind: "checkpoint",
            targetId: "checkpoint-1",
            provider: "tangle",
          }),
          status,
          message: "remote cleanup outcome",
        }),
      ).toThrow(/retry is safe/);
    },
  );

  it("rejects malformed requests before matching acknowledgements", () => {
    expect(
      workspaceCleanupAcknowledgementMatches(
        {
          operationId: "",
          kind: "checkpoint",
          targetId: "checkpoint-1",
          provider: "tangle",
          requestDigest: workspaceCleanupRequestDigest({
            kind: "checkpoint",
            targetId: "checkpoint-1",
            provider: "tangle",
          }),
        },
        {
          operationId: "",
          kind: "checkpoint",
          targetId: "checkpoint-1",
          provider: "tangle",
          requestDigest: workspaceCleanupRequestDigest({
            kind: "checkpoint",
            targetId: "checkpoint-1",
            provider: "tangle",
          }),
          status: "deleted",
        },
      ),
    ).toBe(false);
    expect(
      workspaceCleanupAcknowledgementMatches(
        {
          operationId: "cleanup-1",
          kind: "checkpoint",
          targetId: "checkpoint-1",
          provider: "tangle",
          requestDigest: workspaceCleanupRequestDigest({
            kind: "checkpoint",
            targetId: "checkpoint-1",
            provider: "tangle",
          }),
        },
        {
          operationId: "cleanup-1",
          kind: "fork",
          targetId: "checkpoint-1",
          provider: "tangle",
          requestDigest: workspaceCleanupRequestDigest({
            kind: "fork",
            targetId: "checkpoint-1",
            provider: "tangle",
          }),
          status: "deleted",
        },
      ),
    ).toBe(false);
  });
});
