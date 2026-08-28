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

/** What the provider knows about one operation key before it acts on it. */
type Resolved<TRecord> =
  | { state: "known"; record: TRecord }
  | { state: "conflict"; existingRequestDigest: `sha256:${string}` }
  | { state: "undecided"; message: string }
  | { state: "absent" };

export interface TangleWorkspaceBranchingOptions {
  box: SandboxInstanceLike;
  client: SandboxClientLike;
  provider: string;
  confidentialAttestationVerifier?: TangleConfidentialAttestationVerifier;
}

/**
 * Carry the verifier only when the caller supplied one. Every option type that
 * accepts it is exact-optional, so an explicit `undefined` is not an absent key.
 */
export function confidentialVerifierOption(
  verifier: TangleConfidentialAttestationVerifier | undefined,
): { confidentialAttestationVerifier?: TangleConfidentialAttestationVerifier } {
  return verifier === undefined ? {} : { confidentialAttestationVerifier: verifier };
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

  /**
   * Answer what this provider already knows about one checkpoint key.
   *
   * The in-process record answers first; otherwise the Sandbox inventory and
   * operation ledger rebuild it after a restart. `absent` means the key has no
   * resource this provider created, which is the only state where a caller may
   * go on to create one.
   */
  const resolveCheckpoint = async (
    request: Pick<WorkspaceCheckpointRequest, "idempotencyKey" | "requestDigest">,
  ): Promise<Resolved<CheckpointRecord>> => {
    const local = checkpoints.get(request.idempotencyKey);
    if (local) {
      return local.request.requestDigest === request.requestDigest
        ? { state: "known", record: local }
        : { state: "conflict", existingRequestDigest: local.request.requestDigest };
    }
    const recovered = await findCheckpointByKey(box, request.idempotencyKey);
    if (recovered === undefined) {
      return { state: "undecided", message: "Sandbox checkpoint inventory is unavailable" };
    }
    if (!recovered) return { state: "absent" };
    if (recovered.marker.requestDigest !== request.requestDigest) {
      return { state: "conflict", existingRequestDigest: recovered.marker.requestDigest };
    }
    const record = checkpointRecordFromSnapshot(
      recovered.marker.request,
      recovered.snapshot,
    );
    if (!record) {
      return { state: "undecided", message: "Sandbox checkpoint metadata is invalid" };
    }
    checkpoints.set(request.idempotencyKey, record);
    return { state: "known", record };
  };

  /** The fork equivalent of {@link resolveCheckpoint}. */
  const resolveFork = async (
    request: Pick<WorkspaceForkRequest, "idempotencyKey" | "requestDigest">,
    signal?: AbortSignal,
  ): Promise<Resolved<ForkRecord>> => {
    const local = forks.get(request.idempotencyKey);
    if (local) {
      return local.request.requestDigest === request.requestDigest
        ? { state: "known", record: local }
        : { state: "conflict", existingRequestDigest: local.request.requestDigest };
    }
    const recovered = await findForkByKey(client, box, provider, request.idempotencyKey);
    if (recovered === undefined) {
      return { state: "undecided", message: "Sandbox child inventory is unavailable" };
    }
    if (!recovered) return { state: "absent" };
    if (recovered.marker.requestDigest !== request.requestDigest) {
      return { state: "conflict", existingRequestDigest: recovered.marker.requestDigest };
    }
    const environment = await environmentFromChild(
      recovered.marker.request,
      recovered.child,
      provider,
      recovered.child.createdAt,
      options.confidentialAttestationVerifier,
      signal,
    );
    if (!environment) {
      return { state: "undecided", message: "Sandbox fork child identity is incomplete" };
    }
    const record = { request: recovered.marker.request, environment, child: recovered.child };
    forks.set(request.idempotencyKey, record);
    return { state: "known", record };
  };

  const checkpoint = async (
    input: WorkspaceCheckpointRequest,
    operation?: { signal?: AbortSignal },
  ): Promise<WorkspaceCheckpointResult> => {
    const request = WorkspaceCheckpointRequestSchema.parse(input);
    assertCheckpointSource(request, provider, box.id);
    const known = await resolveCheckpoint(request);
    if (known.state === "conflict") {
      return checkpointConflict(request, known.existingRequestDigest);
    }
    if (known.state === "undecided") {
      return checkpointUnknown(request, `${known.message}; retry after reconciliation`, true);
    }
    if (known.state === "known") {
      return checkpointSuccess(request, known.record.checkpoint, "replayed");
    }

    const tags = checkpointMarkerTags(request);
    let result: SandboxSnapshotResultLike;
    try {
      result = await awaitWithSignal(
        box.snapshot?.({ tags, idempotencyKey: request.idempotencyKey }),
        operation?.signal,
      );
    } catch (error) {
      const conflict = await checkpointConflictFromRemote(box, request);
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
    const known = await resolveCheckpoint(request);
    if (known.state === "conflict") {
      return checkpointLookupConflict(request, known.existingRequestDigest);
    }
    if (known.state === "undecided") {
      return checkpointLookupUnknown(request, known.message, true);
    }
    if (known.state === "known") {
      return checkpointFound(request, known.record.checkpoint);
    }

    try {
      const lookup = await awaitWithSignal(
        box.getSnapshotOperation?.(request.idempotencyKey, { tags: [] }),
        operation?.signal,
      );
      const settled = lookupOutcomeFromSandbox(lookup, "checkpoint");
      return settled.absent
        ? checkpointNotFound(request)
        : checkpointLookupUnknown(request, settled.message, settled.retryable);
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

    const blocking = await findBlockingForks(box, client, provider, request.targetId);
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

    const known = await findManagedCheckpoint(box, provider, request.targetId);
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
    forgetRecords(checkpoints, (record) => record.snapshotId === request.targetId);
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
    const known = await resolveFork(request, operation?.signal);
    if (known.state === "conflict") {
      return forkConflict(request, known.existingRequestDigest);
    }
    if (known.state === "undecided") {
      return forkUnknown(request, `${known.message}; retry after reconciliation`, true);
    }
    if (known.state === "known") {
      return forkSuccess(request, known.record.environment, "replayed");
    }

    const checkpoint = await findManagedCheckpoint(
      box,
      provider,
      request.checkpoint.checkpointId,
      request.checkpoint,
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
    const known = await resolveFork(request, operation?.signal);
    if (known.state === "conflict") {
      return forkLookupConflict(request, known.existingRequestDigest);
    }
    if (known.state === "undecided") {
      return forkLookupUnknown(request, known.message, true);
    }
    if (known.state === "known") {
      return forkFound(request, known.record.environment);
    }

    try {
      const lookup = await awaitWithSignal(
        box.getForkOperation?.(request.idempotencyKey, {
          count: 1,
          metadata: {},
        }),
        operation?.signal,
      );
      const settled = lookupOutcomeFromSandbox(lookup, "fork");
      return settled.absent
        ? forkNotFound(request)
        : forkLookupUnknown(request, settled.message, settled.retryable);
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
    forgetRecords(
      forks,
      (record) => record.environment.environmentId === request.targetId,
    );
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

/** Drop every in-process record for a resource the platform no longer holds. */
function forgetRecords<T>(records: Map<string, T>, matches: (record: T) => boolean): void {
  for (const [key, record] of records) {
    if (matches(record)) records.delete(key);
  }
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
  const encoded = encodeJson(marker);
  if (encoded === undefined) throw new Error("workspace marker is not JSON serializable");
  const base = `${MARKER_PREFIX}:checkpoint`;
  const chunks = split(encoded);
  if (chunks.length > MAX_MARKER_CHUNKS) {
    throw new Error("workspace marker exceeds the recovery bound");
  }
  return [
    `${base}:key:${encodeText(request.idempotencyKey)}`,
    `${base}:digest:${request.requestDigest}`,
    ...chunks.map((chunk, index) => `${base}:material:${index}:${chunks.length}:${chunk}`),
  ];
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

/**
 * Ask the Sandbox operation ledger whether a marked checkpoint settled.
 *
 * A marker only names a candidate resource. Nothing is returned to a caller
 * until the ledger reports the operation succeeded.
 */
async function checkpointOperationSucceeded(
  box: SandboxInstanceLike,
  marker: CheckpointMarker,
): Promise<boolean> {
  const lookup = await box.getSnapshotOperation?.(marker.idempotencyKey, {
    tags: checkpointMarkerTags(marker.request),
  });
  return (
    lookup?.outcome === "found" &&
    lookup.kind === "checkpoint" &&
    lookup.state === "succeeded"
  );
}

/** The fork equivalent of {@link checkpointOperationSucceeded}. */
async function forkOperationSucceeded(
  box: SandboxInstanceLike,
  marker: ForkMarker,
): Promise<boolean> {
  const lookup = await box.getForkOperation?.(marker.idempotencyKey, {
    count: 1,
    metadata: forkMarkerMetadata(marker.request),
  });
  return (
    lookup?.outcome === "found" &&
    lookup.kind === "fork" &&
    lookup.state === "succeeded"
  );
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
      if (await checkpointOperationSucceeded(box, marker)) {
        return { snapshot, marker };
      }
      unresolved = true;
    } catch {
      return undefined;
    }
  }
  return unresolved ? undefined : null;
}

/**
 * Confirm that one snapshot id is a settled checkpoint this provider created.
 *
 * `expected` binds the answer to a specific checkpoint reference. A reference
 * that does not match its marker is absent, not unknown: the caller supplied a
 * checkpoint this source never produced.
 */
async function findManagedCheckpoint(
  box: SandboxInstanceLike,
  provider: string,
  id: string,
  expected?: WorkspaceCheckpointRef,
): Promise<true | false | "unknown"> {
  try {
    const snapshots = await box.listSnapshots?.();
    if (!Array.isArray(snapshots) || snapshots.length > MAX_LIST_RESULTS) {
      return "unknown";
    }
    const snapshot = snapshots.find((candidate) => candidate.snapshotId === id);
    if (!snapshot) return false;
    if (!validSnapshotInfo(snapshot, box.id)) return "unknown";
    const marker = checkpointMarkerFromTags(snapshot.tags, expected?.idempotencyKey);
    if (!marker) return expected ? false : "unknown";
    if (
      marker.request.source.provider !== provider ||
      marker.request.source.environmentId !== box.id
    ) {
      return expected ? false : "unknown";
    }
    if (
      expected &&
      (marker.requestDigest !== expected.requestDigest ||
        canonicalCandidateDigest(marker.request.source) !==
          canonicalCandidateDigest(expected.source))
    ) {
      return false;
    }
    return (await checkpointOperationSucceeded(box, marker)) ? true : "unknown";
  } catch {
    return "unknown";
  }
}

async function findForkByKey(
  client: SandboxClientLike,
  box: SandboxInstanceLike,
  provider: string,
  key: string,
): Promise<{ child: SandboxInstanceLike; marker: ForkMarker } | null | undefined> {
  const candidates = await listMarkedForkChildren(client, box, provider, key);
  if (candidates === undefined) return undefined;
  let unresolved = false;
  for (const candidate of candidates) {
    try {
      if (await forkOperationSucceeded(box, candidate.marker)) return candidate;
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
    if (!marker || !markerBelongsToSource(marker, provider, box.id)) return undefined;
    return (await forkOperationSucceeded(box, marker)) ? child : undefined;
  } catch {
    return undefined;
  }
}

async function findBlockingForks(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  provider: string,
  checkpointId: string,
): Promise<string[] | undefined> {
  const candidates = await listMarkedForkChildren(client, box, provider);
  if (candidates === undefined) return undefined;
  const blocking = new Set<string>();
  for (const { child, marker } of candidates) {
    if (marker.request.checkpoint.checkpointId !== checkpointId) continue;
    try {
      // A candidate that cannot be confirmed leaves the dependency set
      // unknown, so cleanup must not proceed on a partial answer.
      if (!(await forkOperationSucceeded(box, marker))) return undefined;
      blocking.add(child.id);
    } catch {
      return undefined;
    }
  }
  return [...blocking].sort();
}

/**
 * Read every account child that carries a fork marker this source produced.
 *
 * The scan is the shared front half of fork recovery and cleanup. It returns
 * undefined when the inventory itself cannot be trusted, so both callers fail
 * closed on the same condition.
 */
async function listMarkedForkChildren(
  client: SandboxClientLike,
  box: SandboxInstanceLike,
  provider: string,
  key?: string,
): Promise<{ child: SandboxInstanceLike; marker: ForkMarker }[] | undefined> {
  let children: SandboxInstanceLike[];
  try {
    const listed = await client.list?.({ scope: "all", limit: MAX_LIST_RESULTS });
    if (!Array.isArray(listed)) return undefined;
    children = listed;
  } catch {
    return undefined;
  }
  if (children.length > MAX_LIST_RESULTS) return undefined;
  const marked: { child: SandboxInstanceLike; marker: ForkMarker }[] = [];
  for (const child of children) {
    if (!child || typeof child !== "object" || safeIdentifier(child.id) === undefined) {
      return undefined;
    }
    if (child.id === box.id) continue;
    const marker = forkMarkerFromMetadata(child.metadata, key);
    if (!marker || !markerBelongsToSource(marker, provider, box.id)) continue;
    marked.push({ child, marker });
  }
  return marked;
}

function markerBelongsToSource(
  marker: ForkMarker,
  provider: string,
  sourceEnvironmentId: string,
): boolean {
  return (
    marker.request.checkpoint.provider === provider &&
    marker.request.checkpoint.source.environmentId === sourceEnvironmentId
  );
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

/**
 * Turn a failed create into a conflict only from provider-owned material.
 *
 * The Sandbox operation ledger also reports a conflicting digest, but that
 * digest covers the Sandbox request body, not this interface's identity, so it
 * is never presented as an interface digest.
 */
async function checkpointConflictFromRemote(
  box: SandboxInstanceLike,
  request: WorkspaceCheckpointRequest,
): Promise<WorkspaceCheckpointResult | undefined> {
  const recovered = await findCheckpointByKey(box, request.idempotencyKey);
  if (recovered && recovered.marker.requestDigest !== request.requestDigest) {
    return checkpointConflict(request, recovered.marker.requestDigest);
  }
  return undefined;
}

/** The fork equivalent of {@link checkpointConflictFromRemote}. */
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
    request.idempotencyKey,
  );
  if (recovered && recovered.marker.requestDigest !== request.requestDigest) {
    return forkConflict(request, recovered.marker.requestDigest);
  }
  return undefined;
}

/**
 * Read a ledger answer for a key that left no marked resource behind.
 *
 * `absent` is the settled answer: a decided operation with no inventory marker
 * means the resource was cleaned after creation, and the provider must not
 * resurrect it from the ledger. Every other state is undecided for the caller.
 */
function lookupOutcomeFromSandbox(
  lookup: SandboxWorkspaceOperationLookupLike | undefined,
  kind: "checkpoint" | "fork",
): { absent: true } | { absent: false; message: string; retryable: boolean } {
  if (!lookup || lookup.kind !== kind) {
    return { absent: false, message: `Sandbox returned no ${kind} lookup`, retryable: true };
  }
  if (lookup.outcome === "conflict") {
    return {
      absent: false,
      message: "Sandbox found a conflicting operation without provider identity",
      retryable: false,
    };
  }
  if (lookup.outcome !== "not_found" && (lookup.outcome === "unknown" || lookup.state !== "succeeded")) {
    return { absent: false, message: `Sandbox ${kind} operation is not decided`, retryable: true };
  }
  return { absent: true };
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
