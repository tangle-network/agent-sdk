import type {
  AgentWorkspaceBranching,
} from "@tangle-network/agent-interface";
import {
  ConfidentialAttestationSchema,
  ConfidentialExecutionRequestSchema,
  ForkedEnvironmentRefSchema,
  WorkspaceCheckpointRefSchema,
  WorkspaceCheckpointRequestSchema,
  WorkspaceCleanupAcknowledgementSchema,
  WorkspaceCleanupRequestSchema,
  WorkspaceForkRequestSchema,
  WorkspaceOperationLookupRequestSchema,
  WorkspaceCheckpointResultSchema,
  WorkspaceCheckpointLookupResultSchema,
  WorkspaceForkResultSchema,
  WorkspaceForkLookupResultSchema,
  canonicalCandidateDigest,
  confidentialExecutionVerified,
  forkedEnvironmentConfidentialityVerified,
  sha256Bytes,
} from "@tangle-network/agent-interface";
import type {
  ConfidentialAttestation,
  ConfidentialExecutionEnvironment,
  ForkedEnvironmentRef,
  WorkspaceCheckpointLookupResult,
  WorkspaceCheckpointRef,
  WorkspaceCheckpointRequest,
  WorkspaceCheckpointResult,
  WorkspaceCleanupAcknowledgement,
  WorkspaceCleanupRequest,
  WorkspaceForkLookupResult,
  WorkspaceForkRequest,
  WorkspaceForkResult,
  WorkspaceOperationLookupRequest,
} from "@tangle-network/agent-interface";
import {
  awaitWithSignal,
  boundedIdentifier,
  boundedString,
  assertBoundedJson,
  MAX_LIST_RESULTS,
  MAX_STRING_LENGTH,
} from "./tangle-contract-safety.js";
import type {
  SandboxClientLike,
  SandboxDeleteAcknowledgementLike,
  SandboxForkAcknowledgementLike,
  SandboxInstanceLike,
  SandboxSnapshotInfoLike,
  SandboxSnapshotDeleteAcknowledgementLike,
  SandboxSnapshotResultLike,
  SandboxTeeAttestationResponseLike,
  SandboxWorkspaceOperationLookupLike,
  TangleConfidentialAttestationVerifier,
} from "./tangle-types.js";

/**
 * Namespace used for provider recovery metadata.
 *
 * The values are identity markers, not security evidence. A marker can tell
 * the provider which request produced a resource, but only the Sandbox
 * operation ledger and the external verifier can prove an outcome.
 */
const MARKER_PREFIX = "tangle-agent-sdk:workspace:v1";
const FORK_METADATA_KEY = "__tangle_agent_workspace_v1";
const MARKER_CHUNK_SIZE = 240;
const MAX_MARKER_CHUNKS = 512;

interface CheckpointMarker {
  version: 1;
  kind: "checkpoint";
  idempotencyKey: string;
  requestDigest: `sha256:${string}`;
  request: WorkspaceCheckpointRequest;
}

interface ForkMarker {
  version: 1;
  kind: "fork";
  idempotencyKey: string;
  requestDigest: `sha256:${string}`;
  request: WorkspaceForkRequest;
}

interface CheckpointRecord {
  request: WorkspaceCheckpointRequest;
  checkpoint: WorkspaceCheckpointRef;
  snapshotId: string;
}

interface ForkRecord {
  request: WorkspaceForkRequest;
  environment: ForkedEnvironmentRef;
  child: SandboxInstanceLike;
}

interface CleanupRecord {
  requestDigest: `sha256:${string}`;
  acknowledgement: WorkspaceCleanupAcknowledgement;
}

export interface TangleWorkspaceBranchingOptions {
  box: SandboxInstanceLike;
  client: SandboxClientLike;
  provider: string;
  confidentialAttestationVerifier?: TangleConfidentialAttestationVerifier;
}

/**
 * Build the exact workspace contract over the managed Sandbox operations.
 *
 * The adapter requires list and lookup surfaces in addition to create and
 * delete methods. Without recovery, it cannot safely claim durable branching.
 */
export function createTangleWorkspaceBranching(
  options: TangleWorkspaceBranchingOptions,
): AgentWorkspaceBranching | undefined {
  const { box, client, provider } = options;
  boundedIdentifier(provider, "Tangle workspace branching provider");
  boundedIdentifier(box.id, "Tangle workspace branching environment id");
  if (!supportsWorkspaceBranching(box, client)) return undefined;

  const checkpoints = new Map<string, CheckpointRecord>();
  const forks = new Map<string, ForkRecord>();
  const cleanup = new Map<string, CleanupRecord>();

  const checkpoint = async (
    input: WorkspaceCheckpointRequest,
    operation?: { signal?: AbortSignal },
  ): Promise<WorkspaceCheckpointResult> => {
    const request = WorkspaceCheckpointRequestSchema.parse(input);
    assertCheckpointSource(request, provider, box.id);
    const local = checkpoints.get(request.idempotencyKey);
    if (local) {
      if (local.request.requestDigest !== request.requestDigest) {
        return checkpointConflict(request, local.request.requestDigest);
      }
      return checkpointSuccess(request, local.checkpoint, "replayed");
    }

    const recovered = await findCheckpointByKey(box, request.idempotencyKey);
    if (recovered === undefined) {
      return checkpointUnknown(
        request,
        "Sandbox checkpoint inventory is unavailable; retry after reconciliation",
        true,
      );
    }
    if (recovered) {
      if (recovered.marker.requestDigest !== request.requestDigest) {
        return checkpointConflict(request, recovered.marker.requestDigest);
      }
      const record = checkpointRecordFromSnapshot(request, recovered.snapshot);
      if (!record) {
        return checkpointUnknown(
          request,
          "Sandbox checkpoint metadata is invalid; retry after reconciliation",
          true,
        );
      }
      checkpoints.set(request.idempotencyKey, record);
      return checkpointSuccess(request, record.checkpoint, "replayed");
    }

    const tags = checkpointMarkerTags(request);
    let result: SandboxSnapshotResultLike;
    try {
      result = await awaitWithSignal(
        box.snapshot?.({ tags, idempotencyKey: request.idempotencyKey }),
        operation?.signal,
      );
    } catch (error) {
      const conflict = await checkpointConflictFromRemote(
        box,
        request,
        operation?.signal,
      );
      return (
        conflict ??
        checkpointUnknown(
          request,
          `Sandbox checkpoint outcome is unresolved: ${safeError(error)}`,
          true,
        )
      );
    }
    if (!result || !validSnapshotResult(result)) {
      return checkpointUnknown(
        request,
        "Sandbox checkpoint returned no complete idempotent acknowledgement",
        true,
      );
    }
    if (
      result.idempotency === undefined ||
      (result.idempotency.outcome !== "created" &&
        result.idempotency.outcome !== "replayed") ||
      safeString(result.idempotency.requestDigest) === undefined
    ) {
      return checkpointUnknown(
        request,
        "Sandbox checkpoint did not report idempotency state",
        true,
      );
    }
    const resultMarker = checkpointMarkerFromTags(
      result.tags,
      request.idempotencyKey,
    );
    if (!resultMarker || resultMarker.requestDigest !== request.requestDigest) {
      return checkpointUnknown(
        request,
        "Sandbox checkpoint acknowledgement omitted its provider recovery marker",
        true,
      );
    }
    const record = checkpointRecordFromSnapshot(request, result);
    if (!record) {
      return checkpointUnknown(
        request,
        "Sandbox checkpoint acknowledgement contains invalid metadata",
        true,
      );
    }
    checkpoints.set(request.idempotencyKey, record);
    return checkpointSuccess(request, record.checkpoint, result.idempotency.outcome);
  };

  const lookupCheckpoint = async (
    input: WorkspaceOperationLookupRequest,
    operation?: { signal?: AbortSignal },
  ): Promise<WorkspaceCheckpointLookupResult> => {
    const request = WorkspaceOperationLookupRequestSchema.parse(input);
    const local = checkpoints.get(request.idempotencyKey);
    if (local) {
      return local.request.requestDigest === request.requestDigest
        ? checkpointFound(request, local.checkpoint)
        : checkpointLookupConflict(request, local.request.requestDigest);
    }

    const recovered = await findCheckpointByKey(box, request.idempotencyKey);
    if (recovered === undefined) {
      return checkpointLookupUnknown(
        request,
        "Sandbox checkpoint inventory is unavailable",
        true,
      );
    }
    if (recovered) {
      if (recovered.marker.requestDigest !== request.requestDigest) {
        return checkpointLookupConflict(request, recovered.marker.requestDigest);
      }
      const record = checkpointRecordFromSnapshot(
        recovered.marker.request,
        recovered.snapshot,
      );
      if (!record) {
        return checkpointLookupUnknown(
          request,
          "Sandbox checkpoint metadata is invalid",
          true,
        );
      }
      checkpoints.set(request.idempotencyKey, record);
      return checkpointFound(request, record.checkpoint);
    }

    try {
      const lookup = await awaitWithSignal(
        box.getSnapshotOperation?.(request.idempotencyKey, { tags: [] }),
        operation?.signal,
      );
      return checkpointLookupFromSandbox(request, lookup);
    } catch (error) {
      return checkpointLookupUnknown(
        request,
        `Sandbox checkpoint lookup failed: ${safeError(error)}`,
        true,
      );
    }
  };

  const deleteCheckpoint = async (
    input: WorkspaceCleanupRequest & { kind: "checkpoint" },
    operation?: { signal?: AbortSignal },
  ): Promise<WorkspaceCleanupAcknowledgement> => {
    const request = WorkspaceCleanupRequestSchema.parse(input);
    if (request.kind !== "checkpoint") {
      throw new Error("Tangle checkpoint cleanup received a fork request");
    }
    assertCleanupProvider(request, provider);
    const previous = cleanup.get(request.operationId);
    if (previous) {
      if (previous.requestDigest !== request.requestDigest) {
        return cleanupConflict(request, previous.requestDigest);
      }
      if (previous.acknowledgement.status === "in_use") {
        // A dependency response binds the operation id, but it is not
        // terminal. Re-scan children so the same request can converge after
        // callers destroy the blocking fork.
      } else if (previous.acknowledgement.status === "deleted") {
        return cleanupAlreadyAbsent(request);
      } else {
        return previous.acknowledgement;
      }
    }

    const blocking = await findBlockingForks(
      box,
      client,
      box.id,
      provider,
      request.targetId,
    );
    if (blocking === undefined) {
      return cleanupUnknown(
        request,
        "Sandbox child inventory is unavailable; deletion was not attempted",
        true,
      );
    }
    if (blocking.length > 0) {
      const acknowledgement = cleanupInUse(request, blocking);
      cleanup.set(request.operationId, {
        requestDigest: request.requestDigest,
        acknowledgement,
      });
      return acknowledgement;
    }

    const known = await findManagedCheckpointById(box, provider, request.targetId);
    if (known === "unknown") {
      return cleanupUnknown(
        request,
        "Sandbox checkpoint inventory is unavailable; deletion was not attempted",
        true,
      );
    }
    if (known === false) {
      const acknowledgement = cleanupAlreadyAbsent(request);
      cleanup.set(request.operationId, {
        requestDigest: request.requestDigest,
        acknowledgement,
      });
      return acknowledgement;
    }

    let result: SandboxSnapshotDeleteAcknowledgementLike;
    try {
      result = await awaitWithSignal(
        box.deleteSnapshot?.(request.targetId),
        operation?.signal,
      );
    } catch (error) {
      return cleanupTransportFailure(
        request,
        `Sandbox checkpoint deletion failed: ${safeError(error)}`,
        true,
      );
    }
    const outcome =
      result &&
      result.snapshotId === request.targetId &&
      (result.outcome === "deleted" || result.outcome === "already_absent")
        ? result.outcome
        : "unknown";
    if (outcome !== "deleted" && outcome !== "already_absent") {
      return cleanupUnknown(
        request,
        "Sandbox did not attest checkpoint deletion",
        true,
      );
    }
    const acknowledgement =
      outcome === "deleted"
        ? cleanupDeleted(request)
        : cleanupAlreadyAbsent(request);
    if (outcome === "deleted" || outcome === "already_absent") {
      checkpoints.delete(
        [...checkpoints.entries()].find(
          ([, record]) => record.snapshotId === request.targetId,
        )?.[0] ?? "",
      );
    }
    cleanup.set(request.operationId, {
      requestDigest: request.requestDigest,
      acknowledgement,
    });
    return acknowledgement;
  };

  const fork = async (
    input: WorkspaceForkRequest,
    operation?: { signal?: AbortSignal },
  ): Promise<WorkspaceForkResult> => {
    const request = WorkspaceForkRequestSchema.parse(input);
    assertForkSource(request, provider, box.id);
    const local = forks.get(request.idempotencyKey);
    if (local) {
      if (local.request.requestDigest !== request.requestDigest) {
        return forkConflict(request, local.request.requestDigest);
      }
      return forkSuccess(request, local.environment, "replayed");
    }

    const recovered = await findForkByKey(
      client,
      box,
      provider,
      box.id,
      request.idempotencyKey,
    );
    if (recovered === undefined) {
      return forkUnknown(
        request,
        "Sandbox child inventory is unavailable; retry after reconciliation",
        true,
      );
    }
    if (recovered) {
      if (recovered.marker.requestDigest !== request.requestDigest) {
        return forkConflict(request, recovered.marker.requestDigest);
      }
      const environment = await environmentFromChild(
        recovered.marker.request,
        recovered.child,
        provider,
        recovered.child.createdAt,
        options.confidentialAttestationVerifier,
        operation?.signal,
      );
      if (!environment) {
        return forkUnknown(
          request,
          "Sandbox fork exists but its child identity is incomplete",
          true,
        );
      }
      const record = { request: recovered.marker.request, environment, child: recovered.child };
      forks.set(request.idempotencyKey, record);
      return forkSuccess(request, environment, "replayed");
    }

    const checkpoint = await findCheckpointForFork(
      box,
      request.checkpoint,
      provider,
    );
    if (checkpoint !== true) {
      return forkUnknown(
        request,
        checkpoint === false
          ? "Requested checkpoint is absent"
          : "Sandbox checkpoint inventory is unavailable",
        checkpoint === "unknown",
      );
    }

    const metadata = forkMarkerMetadata(request);
    let result: SandboxForkAcknowledgementLike;
    try {
      result = await awaitWithSignal(
        box.fork?.(1, {
          metadata,
          idempotencyKey: request.idempotencyKey,
        }),
        operation?.signal,
      );
    } catch (error) {
      const conflict = await forkConflictFromRemote(
        client,
        box,
        provider,
        request,
      );
      return (
        conflict ??
        forkUnknown(
          request,
          `Sandbox fork outcome is unresolved: ${safeError(error)}`,
          true,
        )
      );
    }
    if (
      !result ||
      !validForkResult(result) ||
      result.idempotency === undefined ||
      (result.idempotency.outcome !== "created" &&
        result.idempotency.outcome !== "replayed") ||
      safeString(result.idempotency.requestDigest) === undefined
    ) {
      return forkUnknown(
        request,
        "Sandbox fork returned no complete idempotent acknowledgement",
        true,
      );
    }
    if (result.children.length !== 1 || result.complete !== true) {
      return forkUnknown(
        request,
        "Sandbox fork did not materialize exactly one complete child",
        true,
      );
    }
    const child = result.children[0];
    const childMarker = forkMarkerFromMetadata(
      child.metadata,
      request.idempotencyKey,
    );
    if (!childMarker || childMarker.requestDigest !== request.requestDigest) {
      return forkUnknown(
        request,
        "Sandbox fork acknowledgement omitted its provider recovery marker",
        true,
      );
    }
    const environment = await environmentFromChild(
      request,
      child,
      provider,
      child.createdAt,
      options.confidentialAttestationVerifier,
      operation?.signal,
    );
    if (!environment) {
      return forkUnknown(
        request,
        "Sandbox fork returned a child without a valid identity",
        true,
      );
    }
    const record = { request, environment, child };
    forks.set(request.idempotencyKey, record);
    return forkSuccess(request, environment, result.idempotency.outcome);
  };

  const lookupFork = async (
    input: WorkspaceOperationLookupRequest,
    operation?: { signal?: AbortSignal },
  ): Promise<WorkspaceForkLookupResult> => {
    const request = WorkspaceOperationLookupRequestSchema.parse(input);
    const local = forks.get(request.idempotencyKey);
    if (local) {
      return local.request.requestDigest === request.requestDigest
        ? forkFound(request, local.environment)
        : forkLookupConflict(request, local.request.requestDigest);
    }

    const recovered = await findForkByKey(
      client,
      box,
      provider,
      box.id,
      request.idempotencyKey,
    );
    if (recovered === undefined) {
      return forkLookupUnknown(
        request,
        "Sandbox child inventory is unavailable",
        true,
      );
    }
    if (recovered) {
      if (recovered.marker.requestDigest !== request.requestDigest) {
        return forkLookupConflict(request, recovered.marker.requestDigest);
      }
      const environment = await environmentFromChild(
        recovered.marker.request,
        recovered.child,
        provider,
        recovered.child.createdAt,
        options.confidentialAttestationVerifier,
        operation?.signal,
      );
      if (!environment) {
        return forkLookupUnknown(
          request,
          "Sandbox fork child identity is incomplete",
          true,
        );
      }
      forks.set(request.idempotencyKey, {
        request: recovered.marker.request,
        environment,
        child: recovered.child,
      });
      return forkFound(request, environment);
    }

    try {
      const lookup = await awaitWithSignal(
        box.getForkOperation?.(request.idempotencyKey, {
          count: 1,
          metadata: {},
        }),
        operation?.signal,
      );
      return forkLookupFromSandbox(request, lookup);
    } catch (error) {
      return forkLookupUnknown(
        request,
        `Sandbox fork lookup failed: ${safeError(error)}`,
        true,
      );
    }
  };

  const destroyFork = async (
    input: WorkspaceCleanupRequest & { kind: "fork" },
    operation?: { signal?: AbortSignal },
  ): Promise<WorkspaceCleanupAcknowledgement> => {
    const request = WorkspaceCleanupRequestSchema.parse(input);
    if (request.kind !== "fork") {
      throw new Error("Tangle fork cleanup received a checkpoint request");
    }
    assertCleanupProvider(request, provider);
    const previous = cleanup.get(request.operationId);
    if (previous) {
      if (previous.requestDigest !== request.requestDigest) {
        return cleanupConflict(request, previous.requestDigest);
      }
      if (previous.acknowledgement.status === "deleted") {
        return cleanupAlreadyAbsent(request);
      }
      return previous.acknowledgement;
    }

    const localFork = [...forks.values()].find(
      (record) => record.environment.environmentId === request.targetId,
    );
    const child = localFork?.child ??
      (await findForkChildById(client, box, provider, request.targetId));
    if (child === undefined) {
      return cleanupUnknown(
        request,
        "Sandbox child inventory is unavailable; destruction was not attempted",
        true,
      );
    }
    if (child === null) {
      const acknowledgement = cleanupAlreadyAbsent(request);
      cleanup.set(request.operationId, {
        requestDigest: request.requestDigest,
        acknowledgement,
      });
      return acknowledgement;
    }

    let result: SandboxDeleteAcknowledgementLike;
    try {
      result = (await awaitWithSignal(child.delete?.(), operation?.signal)) as SandboxDeleteAcknowledgementLike;
    } catch (error) {
      return cleanupTransportFailure(
        request,
        `Sandbox fork destruction failed: ${safeError(error)}`,
        true,
      );
    }
    const outcome =
      result &&
      result.sandboxId === request.targetId &&
      (result.outcome === "destroyed" || result.outcome === "already_absent")
        ? result.outcome
        : "unknown";
    if (outcome !== "destroyed" && outcome !== "already_absent") {
      return cleanupUnknown(
        request,
        "Sandbox did not attest fork destruction",
        true,
      );
    }
    const acknowledgement =
      outcome === "destroyed"
        ? cleanupDeleted(request)
        : cleanupAlreadyAbsent(request);
    if (outcome === "destroyed" || outcome === "already_absent") {
      forks.delete(
        [...forks.entries()].find(
          ([, record]) => record.environment.environmentId === request.targetId,
        )?.[0] ?? "",
      );
    }
    cleanup.set(request.operationId, {
      requestDigest: request.requestDigest,
      acknowledgement,
    });
    return acknowledgement;
  };

  return {
    checkpoint,
    lookupCheckpoint,
    deleteCheckpoint,
    fork,
    lookupFork,
    destroyFork,
  };
}

/** Capability support requires every operation used by recovery and cleanup. */
export function supportsWorkspaceBranching(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
): boolean {
  return (
    typeof client.list === "function" &&
    typeof client.get === "function" &&
    typeof box.snapshot === "function" &&
    typeof box.listSnapshots === "function" &&
    typeof box.deleteSnapshot === "function" &&
    typeof box.getSnapshotOperation === "function" &&
    typeof box.fork === "function" &&
    typeof box.getForkOperation === "function"
  );
}

export function supportsConfidentialAttestation(
  box: SandboxInstanceLike,
  verifier?: TangleConfidentialAttestationVerifier,
): boolean {
  return typeof box.getTeeAttestation === "function" && typeof verifier === "function";
}

function assertCheckpointSource(
  request: WorkspaceCheckpointRequest,
  provider: string,
  environmentId: string,
): void {
  if (
    request.source.provider !== provider ||
    request.source.environmentId !== environmentId
  ) {
    throw new Error("Tangle checkpoint source does not belong to this environment");
  }
}

function assertForkSource(
  request: WorkspaceForkRequest,
  provider: string,
  environmentId: string,
): void {
  if (
    request.checkpoint.provider !== provider ||
    request.checkpoint.source.provider !== provider ||
    request.checkpoint.source.environmentId !== environmentId
  ) {
    throw new Error("Tangle fork checkpoint does not belong to this environment");
  }
}

function assertCleanupProvider(
  request: WorkspaceCleanupRequest,
  provider: string,
): void {
  if (request.provider !== provider) {
    throw new Error("Tangle cleanup provider does not match this provider");
  }
}

function checkpointRecordFromSnapshot(
  request: WorkspaceCheckpointRequest,
  snapshot: SandboxSnapshotResultLike | SandboxSnapshotInfoLike,
): CheckpointRecord | undefined {
  try {
    const createdAt = isoDate(snapshot.createdAt);
    const checkpoint = WorkspaceCheckpointRefSchema.parse({
      checkpointId: boundedIdentifier(snapshot.snapshotId, "Tangle checkpoint id"),
      provider: request.source.provider,
      source: request.source,
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
      createdAt,
      ...(request.metadata === undefined
        ? {}
        : { metadata: cloneJson(request.metadata) }),
    });
    return {
      request,
      checkpoint,
      snapshotId: checkpoint.checkpointId,
    };
  } catch {
    return undefined;
  }
}

async function environmentFromChild(
  request: WorkspaceForkRequest,
  child: SandboxInstanceLike,
  provider: string,
  createdAt: Date | string | undefined,
  verifier: TangleConfidentialAttestationVerifier | undefined,
  signal?: AbortSignal,
): Promise<ForkedEnvironmentRef | undefined> {
  const environmentId = safeIdentifier(child.id);
  if (!environmentId || environmentId === request.checkpoint.source.environmentId) {
    return undefined;
  }
  if (createdAt === undefined) return undefined;
  let normalizedCreatedAt: string;
  try {
    normalizedCreatedAt = isoDate(createdAt);
  } catch {
    return undefined;
  }
  let metadata: Record<string, unknown> | undefined;
  try {
    metadata =
      request.metadata === undefined ? undefined : cloneJson(request.metadata);
  } catch {
    return undefined;
  }
  let attestation: ConfidentialAttestation | undefined;
  if (
    request.confidential?.requested === true &&
    typeof verifier === "function"
  ) {
    attestation = await confidentialAttestationForChild(
      request,
      child,
      provider,
      verifier,
      signal,
    );
  }
  const environment = ForkedEnvironmentRefSchema.safeParse({
    provider,
    environmentId,
    sourceEnvironmentId: request.checkpoint.source.environmentId,
    source: request.checkpoint.source,
    sourceCheckpointId: request.checkpoint.checkpointId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    createdAt: normalizedCreatedAt,
    placement: request.placement,
    confidentialRequested: request.confidential?.requested === true,
    ...(attestation === undefined ? {} : { confidentialAttestation: attestation }),
    ...(attestation === undefined ? {} : { confidential: true }),
    ...(metadata === undefined ? {} : { metadata }),
  });
  return environment.success ? environment.data : undefined;
}

async function confidentialAttestationForChild(
  request: WorkspaceForkRequest,
  child: SandboxInstanceLike,
  provider: string,
  verifier: TangleConfidentialAttestationVerifier,
  signal?: AbortSignal,
): Promise<ConfidentialAttestation | undefined> {
  const confidential = ConfidentialExecutionRequestSchema.parse(request.confidential);
  if (!confidential.requested || typeof child.getTeeAttestation !== "function") {
    return undefined;
  }
  let response: SandboxTeeAttestationResponseLike;
  try {
    response = await awaitWithSignal(
      child.getTeeAttestation({ attestationNonce: confidential.nonce }),
      signal,
    );
  } catch {
    return undefined;
  }
  if (
    !response ||
    response.sandbox_id !== child.id ||
    !validTeeReport(response.attestation) ||
    (response.attestationNonce !== undefined &&
      (safeIdentifier(response.attestationNonce) === undefined ||
        response.attestationNonce !== confidential.nonce))
  ) {
    return undefined;
  }
  const measurement = sha256Bytes(Uint8Array.from(response.attestation.measurement));
  const quote = encodeJson(response.attestation);
  if (quote === undefined) return undefined;
  let verifiedAt: string;
  try {
    verifiedAt = new Date(response.attestation.timestamp * 1_000).toISOString();
  } catch {
    return undefined;
  }
  const expected: ConfidentialExecutionEnvironment = {
    provider,
    environmentId: child.id,
    source: request.checkpoint.source,
    requestDigest: request.requestDigest,
    confidentialRequested: true,
  };
  const material = {
    provider,
    requested: true as const,
    nonce: confidential.nonce,
    measurement,
    environmentId: child.id,
    source: request.checkpoint.source,
    requestDigest: request.requestDigest,
    profileDigest: confidential.profileDigest,
    policy: confidential.policy,
    quote,
    verifiedAt,
  };
  let verification;
  try {
    const provisional = {
      ...material,
      providerKeyId: "unverified",
      providerSignature: "unverified",
    };
    const provisionalResult = ConfidentialAttestationSchema.safeParse(provisional);
    if (!provisionalResult.success) return undefined;
    verification = await verifier({
      report: response.attestation,
      expected,
      attestation: provisionalResult.data,
    });
  } catch {
    return undefined;
  }
  if (
    verification === null ||
    !verification ||
    !safeIdentifier(verification.providerKeyId) ||
    !safeString(verification.providerSignature) ||
    verification.providerSignature === quote ||
    (verification.measurement !== undefined && verification.measurement !== measurement)
  ) {
    return undefined;
  }
  const attestation = ConfidentialAttestationSchema.safeParse({
    ...material,
    providerKeyId: verification.providerKeyId,
    providerSignature: verification.providerSignature,
  });
  if (!attestation.success) return undefined;
  // Run the canonical binding checks as a final local fail-closed assertion.
  return confidentialExecutionVerified({
    request: confidential,
    environment: expected,
    attestation: attestation.data,
    verifyProviderAttestation: () => true,
  })
    ? attestation.data
    : undefined;
}

function validTeeReport(
  report: SandboxTeeAttestationResponseLike["attestation"] | undefined,
): report is NonNullable<SandboxTeeAttestationResponseLike["attestation"]> {
  return !!report &&
    safeString(report.tee_type) !== undefined &&
    Array.isArray(report.evidence) &&
    report.evidence.length <= MAX_STRING_LENGTH &&
    report.evidence.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) &&
    Array.isArray(report.measurement) &&
    report.measurement.length <= MAX_STRING_LENGTH &&
    report.measurement.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) &&
    Number.isFinite(report.timestamp) &&
    report.timestamp > 0;
}

function validSnapshotResult(
  result: SandboxSnapshotResultLike | undefined,
): result is SandboxSnapshotResultLike {
  return !!result &&
    safeIdentifier(result.snapshotId) !== undefined &&
    validDate(result.createdAt) &&
    Array.isArray(result.tags) &&
    result.tags.every((tag) => safeString(tag) !== undefined);
}

function validSnapshotInfo(
  snapshot: SandboxSnapshotInfoLike,
  sandboxId?: string,
): boolean {
  return (
    validSnapshotResult(snapshot) &&
    safeIdentifier(snapshot.sandboxId) !== undefined &&
    (sandboxId === undefined || snapshot.sandboxId === sandboxId)
  );
}

function validForkResult(
  result: SandboxForkAcknowledgementLike | undefined,
): result is SandboxForkAcknowledgementLike {
  return !!result &&
    Array.isArray(result.children) &&
    result.children.every(
      (child) =>
        child !== null &&
        typeof child === "object" &&
        safeIdentifier(child.id) !== undefined,
    ) &&
    result.requestedCount === 1 &&
    result.materializedCount === result.children.length &&
    typeof result.complete === "boolean";
}

function checkpointMarkerTags(request: WorkspaceCheckpointRequest): string[] {
  const marker: CheckpointMarker = {
    version: 1,
    kind: "checkpoint",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    request,
  };
  return markerTags("checkpoint", request.idempotencyKey, request.requestDigest, marker);
}

function forkMarkerMetadata(
  request: WorkspaceForkRequest,
): Record<string, unknown> {
  if (request.metadata && Object.hasOwn(request.metadata, FORK_METADATA_KEY)) {
    throw new Error(`fork metadata reserves ${FORK_METADATA_KEY}`);
  }
  const marker: ForkMarker = {
    version: 1,
    kind: "fork",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    request,
  };
  assertBoundedJson(marker);
  return {
    ...(request.metadata === undefined ? {} : cloneJson(request.metadata)),
    [FORK_METADATA_KEY]: marker,
  };
}

function markerTags(
  kind: "checkpoint" | "fork",
  idempotencyKey: string,
  requestDigest: string,
  marker: CheckpointMarker,
): string[] {
  const encoded = encodeJson(marker);
  if (encoded === undefined) throw new Error("workspace marker is not JSON serializable");
  const base = `${MARKER_PREFIX}:${kind}`;
  const chunks = split(encoded);
  if (chunks.length > MAX_MARKER_CHUNKS) {
    throw new Error("workspace marker exceeds the recovery bound");
  }
  return [
    `${base}:key:${encodeText(idempotencyKey)}`,
    `${base}:digest:${requestDigest}`,
    ...chunks.map((chunk, index) => `${base}:material:${index}:${chunks.length}:${chunk}`),
  ];
}

async function findCheckpointByKey(
  box: SandboxInstanceLike,
  key: string,
): Promise<
  | { snapshot: SandboxSnapshotInfoLike; marker: CheckpointMarker }
  | null
  | undefined
> {
  let snapshots: SandboxSnapshotInfoLike[];
  try {
    const listed = await box.listSnapshots?.();
    if (!Array.isArray(listed)) return undefined;
    snapshots = listed;
  } catch {
    return undefined;
  }
  if (!Array.isArray(snapshots) || snapshots.length > MAX_LIST_RESULTS) {
    return undefined;
  }
  let unresolved = false;
  for (const snapshot of snapshots) {
    if (!validSnapshotInfo(snapshot, box.id)) return undefined;
    const marker = checkpointMarkerFromTags(snapshot.tags, key);
    if (!marker) continue;
    try {
      const lookup = await box.getSnapshotOperation?.(
        marker.idempotencyKey,
        { tags: checkpointMarkerTags(marker.request) },
      );
      if (
        lookup?.outcome === "found" &&
        lookup.state === "succeeded" &&
        lookup.kind === "checkpoint"
      ) {
        return { snapshot, marker };
      }
      unresolved = true;
    } catch {
      return undefined;
    }
  }
  return unresolved ? undefined : null;
}

async function findManagedCheckpointById(
  box: SandboxInstanceLike,
  provider: string,
  id: string,
): Promise<true | false | "unknown"> {
  try {
    const snapshots = await box.listSnapshots?.();
    if (!Array.isArray(snapshots) || snapshots.length > MAX_LIST_RESULTS) {
      return "unknown";
    }
    const snapshot = snapshots.find((candidate) => candidate.snapshotId === id);
    if (!snapshot) return false;
    if (!validSnapshotInfo(snapshot, box.id)) return "unknown";
    const marker = checkpointMarkerFromTags(snapshot.tags);
    if (!marker) return "unknown";
    if (marker.request.source.provider !== provider || marker.request.source.environmentId !== box.id) return "unknown";
    const lookup = await box.getSnapshotOperation?.(
      marker.idempotencyKey,
      { tags: checkpointMarkerTags(marker.request) },
    );
    return lookup?.outcome === "found" &&
      lookup.kind === "checkpoint" &&
      lookup.state === "succeeded"
      ? true
      : "unknown";
  } catch {
    return "unknown";
  }
}

async function findCheckpointForFork(
  box: SandboxInstanceLike,
  checkpoint: WorkspaceCheckpointRef,
  provider: string,
): Promise<true | false | "unknown"> {
  try {
    const snapshots = await box.listSnapshots?.();
    if (!Array.isArray(snapshots) || snapshots.length > MAX_LIST_RESULTS) {
      return "unknown";
    }
    const snapshot = snapshots.find(
      (candidate) => candidate.snapshotId === checkpoint.checkpointId,
    );
    if (!snapshot) return false;
    if (!validSnapshotInfo(snapshot, box.id)) return "unknown";
    const marker = checkpointMarkerFromTags(
      snapshot.tags,
      checkpoint.idempotencyKey,
    );
    if (
      !marker ||
      marker.requestDigest !== checkpoint.requestDigest ||
      marker.request.source.provider !== provider ||
      marker.request.source.environmentId !== box.id ||
      canonicalCandidateDigest(marker.request.source) !==
        canonicalCandidateDigest(checkpoint.source)
    ) {
      return false;
    }
    const lookup = await box.getSnapshotOperation?.(
      marker.idempotencyKey,
      { tags: checkpointMarkerTags(marker.request) },
    );
    return lookup?.outcome === "found" &&
      lookup.kind === "checkpoint" &&
      lookup.state === "succeeded"
      ? true
      : "unknown";
  } catch {
    return "unknown";
  }
}

async function findForkByKey(
  client: SandboxClientLike,
  box: SandboxInstanceLike,
  provider: string,
  sourceEnvironmentId: string,
  key: string,
): Promise<{ child: SandboxInstanceLike; marker: ForkMarker } | null | undefined> {
  let children: SandboxInstanceLike[];
  try {
    const listed = await client.list?.({ scope: "all", limit: MAX_LIST_RESULTS });
    if (!Array.isArray(listed)) return undefined;
    children = listed;
  } catch {
    return undefined;
  }
  if (!Array.isArray(children) || children.length > MAX_LIST_RESULTS) {
    return undefined;
  }
  let unresolved = false;
  for (const child of children) {
    if (!child || typeof child !== "object" || safeIdentifier(child.id) === undefined) {
      return undefined;
    }
    if (child.id === sourceEnvironmentId) continue;
    const marker = forkMarkerFromMetadata(child.metadata, key);
    if (!marker) continue;
    if (
      marker.request.checkpoint.provider !== provider ||
      marker.request.checkpoint.source.environmentId !== sourceEnvironmentId
    ) {
      continue;
    }
    try {
      const lookup = await box.getForkOperation?.(marker.idempotencyKey, {
        count: 1,
        metadata: forkMarkerMetadata(marker.request),
      });
      if (
        lookup?.outcome === "found" &&
        lookup.state === "succeeded" &&
        lookup.kind === "fork"
      ) {
        return { child, marker };
      }
      unresolved = true;
    } catch {
      return undefined;
    }
  }
  return unresolved ? undefined : null;
}

async function findForkChildById(
  client: SandboxClientLike,
  box: SandboxInstanceLike,
  provider: string,
  id: string,
): Promise<SandboxInstanceLike | null | undefined> {
  try {
    if (typeof client.get !== "function") return undefined;
    const child = await client.get(id);
    if (child === null) return null;
    if (child.id !== id) return undefined;
    const marker = forkMarkerFromMetadata(child.metadata);
    if (
      !marker ||
      marker.request.checkpoint.provider !== provider ||
      marker.request.checkpoint.source.environmentId !== box.id
    ) {
      return undefined;
    }
    const lookup = await box.getForkOperation?.(marker.idempotencyKey, {
      count: 1,
      metadata: forkMarkerMetadata(marker.request),
    });
    return lookup?.outcome === "found" && lookup.state === "succeeded"
      ? child
      : undefined;
  } catch {
    return undefined;
  }
}

async function findBlockingForks(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  sourceEnvironmentId: string,
  provider: string,
  checkpointId: string,
): Promise<string[] | undefined> {
  let children: SandboxInstanceLike[];
  try {
    const listed = await client.list?.({ scope: "all", limit: MAX_LIST_RESULTS });
    if (!Array.isArray(listed)) return undefined;
    children = listed;
  } catch {
    return undefined;
  }
  if (!Array.isArray(children) || children.length > MAX_LIST_RESULTS) {
    return undefined;
  }
  const blocking: string[] = [];
  for (const child of children) {
    if (!child || typeof child !== "object" || safeIdentifier(child.id) === undefined) {
      return undefined;
    }
    if (child.id === sourceEnvironmentId) continue;
    const marker = forkMarkerFromMetadata(child.metadata);
    if (
      !marker ||
      marker.request.checkpoint.provider !== provider ||
      marker.request.checkpoint.source.environmentId !== sourceEnvironmentId ||
      marker.request.checkpoint.checkpointId !== checkpointId
    ) {
      continue;
    }
    try {
      const lookup = await box.getForkOperation?.(marker.idempotencyKey, {
        count: 1,
        metadata: forkMarkerMetadata(marker.request),
      });
      if (
        !lookup ||
        lookup.kind !== "fork" ||
        lookup.outcome !== "found" ||
        lookup.state !== "succeeded"
      ) {
        return undefined;
      }
      blocking.push(child.id);
    } catch {
      return undefined;
    }
  }
  return blocking.filter((id, index, values) => values.indexOf(id) === index).sort();
}

function checkpointMarkerFromTags(
  tags: string[] | undefined,
  key?: string,
): CheckpointMarker | undefined {
  if (
    !Array.isArray(tags) ||
    tags.length > MAX_MARKER_CHUNKS + 3 ||
    !tags.every((tag) => safeString(tag) !== undefined)
  ) {
    return undefined;
  }
  const base = `${MARKER_PREFIX}:checkpoint`;
  const keyTag = tags.find((tag) => tag.startsWith(`${base}:key:`));
  if (keyTag && key !== undefined && decodeText(keyTag.slice(`${base}:key:`.length)) !== key) {
    return undefined;
  }
  const chunks = tags
    .map((tag) => {
      const match = tag.match(new RegExp(`^${escapeRegExp(base)}:material:(\\d+):(\\d+):(.+)$`));
      return match ? { index: Number(match[1]), total: Number(match[2]), chunk: match[3] } : undefined;
    })
    .filter((value): value is { index: number; total: number; chunk: string } => value !== undefined)
    .sort((left, right) => left.index - right.index);
  if (
    chunks.length === 0 ||
    chunks[0].total < 1 ||
    chunks[0].total > MAX_MARKER_CHUNKS ||
    chunks[0].total !== chunks.length ||
    chunks.some(
      (chunk, index) =>
        !Number.isSafeInteger(chunk.index) ||
        !Number.isSafeInteger(chunk.total) ||
        chunk.index !== index ||
        chunk.total !== chunks[0].total,
    )
  ) {
    return undefined;
  }
  const decoded = decodeJson(chunks.map((chunk) => chunk.chunk).join(""));
  return checkpointMarkerFromUnknown(decoded, key);
}

function checkpointMarkerFromUnknown(
  value: unknown,
  key?: string,
): CheckpointMarker | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Partial<CheckpointMarker>;
  if (parsed.version !== 1 || parsed.kind !== "checkpoint" || typeof parsed.idempotencyKey !== "string" || typeof parsed.requestDigest !== "string") return undefined;
  if (key !== undefined && parsed.idempotencyKey !== key) return undefined;
  const request = WorkspaceCheckpointRequestSchema.safeParse(parsed.request);
  if (!request.success || request.data.idempotencyKey !== parsed.idempotencyKey || request.data.requestDigest !== parsed.requestDigest) return undefined;
  return { version: 1, kind: "checkpoint", idempotencyKey: parsed.idempotencyKey, requestDigest: parsed.requestDigest, request: request.data };
}

function forkMarkerFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key?: string,
): ForkMarker | undefined {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !Object.hasOwn(metadata, FORK_METADATA_KEY)
  ) {
    return undefined;
  }
  const value = metadata[FORK_METADATA_KEY];
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Partial<ForkMarker>;
  if (parsed.version !== 1 || parsed.kind !== "fork" || typeof parsed.idempotencyKey !== "string" || typeof parsed.requestDigest !== "string") return undefined;
  if (key !== undefined && parsed.idempotencyKey !== key) return undefined;
  const request = WorkspaceForkRequestSchema.safeParse(parsed.request);
  if (!request.success || request.data.idempotencyKey !== parsed.idempotencyKey || request.data.requestDigest !== parsed.requestDigest) return undefined;
  return { version: 1, kind: "fork", idempotencyKey: parsed.idempotencyKey, requestDigest: parsed.requestDigest, request: request.data };
}

async function checkpointConflictFromRemote(
  box: SandboxInstanceLike,
  request: WorkspaceCheckpointRequest,
  signal?: AbortSignal,
): Promise<WorkspaceCheckpointResult | undefined> {
  const recovered = await findCheckpointByKey(box, request.idempotencyKey);
  if (recovered && recovered.marker.requestDigest !== request.requestDigest) {
    return checkpointConflict(request, recovered.marker.requestDigest);
  }
  try {
    const lookup = await awaitWithSignal(
      box.getSnapshotOperation?.(request.idempotencyKey, { tags: checkpointMarkerTags(request) }),
      signal,
    );
    if (lookup?.outcome === "conflict" && validDigest(lookup.existingRequestDigest)) {
      // The server digest covers Sandbox's request body, not this interface's
      // identity. Do not present it as an interface digest.
      return undefined;
    }
  } catch {
    // The original error is the useful bounded failure for the caller.
  }
  return undefined;
}

async function forkConflictFromRemote(
  client: SandboxClientLike,
  box: SandboxInstanceLike,
  provider: string,
  request: WorkspaceForkRequest,
): Promise<WorkspaceForkResult | undefined> {
  const recovered = await findForkByKey(
    client,
    box,
    provider,
    box.id,
    request.idempotencyKey,
  );
  if (recovered && recovered.marker.requestDigest !== request.requestDigest) {
    return forkConflict(request, recovered.marker.requestDigest);
  }
  return undefined;
}

function checkpointLookupFromSandbox(
  request: WorkspaceOperationLookupRequest,
  lookup: SandboxWorkspaceOperationLookupLike | undefined,
): WorkspaceCheckpointLookupResult {
  if (!lookup || lookup.kind !== "checkpoint") return checkpointLookupUnknown(request, "Sandbox returned no checkpoint lookup", true);
  if (lookup.outcome === "not_found") return checkpointNotFound(request);
  if (lookup.outcome === "conflict") return checkpointLookupUnknown(request, "Sandbox found a conflicting operation without provider identity", false);
  if (lookup.outcome === "unknown" || lookup.state !== "succeeded") return checkpointLookupUnknown(request, "Sandbox checkpoint operation is not decided", true);
  // A settled operation with no inventory marker means the resource was
  // cleaned after creation. The provider must not resurrect it from the
  // operation ledger.
  return checkpointNotFound(request);
}

function forkLookupFromSandbox(
  request: WorkspaceOperationLookupRequest,
  lookup: SandboxWorkspaceOperationLookupLike | undefined,
): WorkspaceForkLookupResult {
  if (!lookup || lookup.kind !== "fork") return forkLookupUnknown(request, "Sandbox returned no fork lookup", true);
  if (lookup.outcome === "not_found") return forkNotFound(request);
  if (lookup.outcome === "conflict") return forkLookupUnknown(request, "Sandbox found a conflicting operation without provider identity", false);
  if (lookup.outcome === "unknown" || lookup.state !== "succeeded") return forkLookupUnknown(request, "Sandbox fork operation is not decided", true);
  return forkNotFound(request);
}

function checkpointSuccess(
  request: WorkspaceCheckpointRequest,
  checkpoint: WorkspaceCheckpointRef,
  status: "created" | "replayed",
): WorkspaceCheckpointResult {
  return WorkspaceCheckpointResultSchema.parse({ status, idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, checkpoint });
}

function checkpointConflict(request: WorkspaceCheckpointRequest, existingRequestDigest: string): WorkspaceCheckpointResult {
  return WorkspaceCheckpointResultSchema.parse({ status: "conflict", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, existingRequestDigest });
}

function checkpointUnknown(request: WorkspaceCheckpointRequest, message: string, retryable: boolean): WorkspaceCheckpointResult {
  return WorkspaceCheckpointResultSchema.parse({ status: "unknown", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, message: boundedString(message, "Tangle checkpoint error"), retryable });
}

function checkpointFound(request: WorkspaceOperationLookupRequest, checkpoint: WorkspaceCheckpointRef): WorkspaceCheckpointLookupResult {
  return WorkspaceCheckpointLookupResultSchema.parse({ status: "found", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, checkpoint });
}

function checkpointNotFound(request: WorkspaceOperationLookupRequest): WorkspaceCheckpointLookupResult {
  return WorkspaceCheckpointLookupResultSchema.parse({ status: "not_found", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest });
}

function checkpointLookupConflict(request: WorkspaceOperationLookupRequest, existingRequestDigest: string): WorkspaceCheckpointLookupResult {
  return WorkspaceCheckpointLookupResultSchema.parse({ status: "conflict", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, existingRequestDigest });
}

function checkpointLookupUnknown(request: WorkspaceOperationLookupRequest, message: string, retryable: boolean): WorkspaceCheckpointLookupResult {
  return WorkspaceCheckpointLookupResultSchema.parse({ status: "unknown", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, message: boundedString(message, "Tangle checkpoint lookup error"), retryable });
}

function forkSuccess(request: WorkspaceForkRequest, environment: ForkedEnvironmentRef, status: "created" | "replayed"): WorkspaceForkResult {
  return WorkspaceForkResultSchema.parse({ status, idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, environment });
}

function forkConflict(request: WorkspaceForkRequest, existingRequestDigest: string): WorkspaceForkResult {
  return WorkspaceForkResultSchema.parse({ status: "conflict", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, existingRequestDigest });
}

function forkUnknown(request: WorkspaceForkRequest, message: string, retryable: boolean): WorkspaceForkResult {
  return WorkspaceForkResultSchema.parse({ status: "unknown", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, message: boundedString(message, "Tangle fork error"), retryable });
}

function forkFound(request: WorkspaceOperationLookupRequest, environment: ForkedEnvironmentRef): WorkspaceForkLookupResult {
  return WorkspaceForkLookupResultSchema.parse({ status: "found", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, environment });
}

function forkNotFound(request: WorkspaceOperationLookupRequest): WorkspaceForkLookupResult {
  return WorkspaceForkLookupResultSchema.parse({ status: "not_found", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest });
}

function forkLookupConflict(request: WorkspaceOperationLookupRequest, existingRequestDigest: string): WorkspaceForkLookupResult {
  return WorkspaceForkLookupResultSchema.parse({ status: "conflict", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, existingRequestDigest });
}

function forkLookupUnknown(request: WorkspaceOperationLookupRequest, message: string, retryable: boolean): WorkspaceForkLookupResult {
  return WorkspaceForkLookupResultSchema.parse({ status: "unknown", idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, message: boundedString(message, "Tangle fork lookup error"), retryable });
}

function cleanupDeleted(request: WorkspaceCleanupRequest): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({ ...request, status: "deleted" });
}

function cleanupAlreadyAbsent(request: WorkspaceCleanupRequest): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({ ...request, status: "already_absent" });
}

function cleanupConflict(request: WorkspaceCleanupRequest, existingRequestDigest: string): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({ ...request, status: "conflict", existingRequestDigest, message: "Cleanup operation id is bound to another target" });
}

function cleanupInUse(request: WorkspaceCleanupRequest, blockingTargetIds: string[]): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({ ...request, status: "in_use", blockingTargetIds, message: "Checkpoint is still referenced by forked environments" });
}

function cleanupUnknown(request: WorkspaceCleanupRequest, message: string, retryable: boolean): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({ ...request, status: "unknown", message: boundedString(message, "Tangle cleanup error"), retryable });
}

function cleanupTransportFailure(request: WorkspaceCleanupRequest, message: string, retryable: boolean): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({ ...request, status: "transport_failure", message: boundedString(message, "Tangle cleanup transport error"), retryable });
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Sandbox returned an invalid workspace timestamp");
  return date.toISOString();
}

function validDate(value: Date | string | undefined): boolean {
  if (value === undefined) return false;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime());
}

function cloneJson<T>(value: T): T {
  assertBoundedJson(value);
  return structuredClone(value);
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.trim() !== value) return undefined;
  return value;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH) return undefined;
  return value;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "transport error";
  return message.slice(0, MAX_STRING_LENGTH);
}

function validDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function encodeText(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeText(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function encodeJson(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    return encodeText(serialized);
  } catch {
    return undefined;
  }
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function split(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += MARKER_CHUNK_SIZE) {
    chunks.push(value.slice(index, index + MARKER_CHUNK_SIZE));
  }
  return chunks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate the attestation a caller received from this provider with the
 * canonical interface verifier. The provider's callback remains the trust
 * boundary for the provider key and hardware quote.
 */
export function tangleWorkspaceConfidentialityVerified(
  request: WorkspaceForkRequest,
  environment: ForkedEnvironmentRef,
  verifier?: Parameters<typeof confidentialExecutionVerified>[0]["verifyProviderAttestation"],
): boolean {
  return forkedEnvironmentConfidentialityVerified(request, environment, verifier);
}
