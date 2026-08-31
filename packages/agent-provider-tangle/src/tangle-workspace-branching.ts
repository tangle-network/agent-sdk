import type { AgentWorkspaceBranching } from "@tangle-network/agent-interface";
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
  SANDBOX_LIST_PAGE_SIZE,
} from "./tangle-contract-safety.js";
import {
  encodeTangleConfidentialAttestationQuote,
  MAX_TEE_EVIDENCE_BYTES,
  MAX_TEE_MEASUREMENT_BYTES,
} from "./tangle-confidential-attestation.js";
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
const MARKER_PREFIX = "tangle-agent-ws-v1";
/** Marker namespace used by releases before the 128-byte tag limit. */
const LEGACY_MARKER_PREFIX = "tangle-agent-sdk:workspace:v1";
const FORK_METADATA_KEY = "__tangle_agent_workspace_v1";
const MAX_MARKER_TAG_LENGTH = 128;
const MARKER_CHUNK_SIZE = 80;
const LEGACY_MARKER_CHUNK_SIZE = 240;
const MAX_MARKER_CHUNKS = 512;
interface CheckpointMarker {
  version: 1;
  kind: "checkpoint";
  idempotencyKey: string;
  requestDigest: `sha256:${string}`;
  request: WorkspaceCheckpointRequest;
  /** True only for markers written by the pre-128-byte-tag release. */
  legacy?: boolean;
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

interface RecoveredForkChild {
  child: SandboxInstanceLike;
  createdAt: Date | string | undefined;
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
  verifier: TangleConfidentialAttestationVerifier | undefined
): { confidentialAttestationVerifier?: TangleConfidentialAttestationVerifier } {
  return verifier === undefined
    ? {}
    : { confidentialAttestationVerifier: verifier };
}

/**
 * Build the exact workspace contract over the managed Sandbox operations.
 *
 * The adapter requires list and lookup surfaces in addition to create and
 * delete methods. Without recovery, it cannot safely claim durable branching.
 */
export function createTangleWorkspaceBranching(
  options: TangleWorkspaceBranchingOptions
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
    request: Pick<
      WorkspaceCheckpointRequest,
      "idempotencyKey" | "requestDigest"
    >,
    signal?: AbortSignal
  ): Promise<Resolved<CheckpointRecord>> => {
    const local = checkpoints.get(request.idempotencyKey);
    if (local) {
      return local.request.requestDigest === request.requestDigest
        ? { state: "known", record: local }
        : {
            state: "conflict",
            existingRequestDigest: local.request.requestDigest,
          };
    }
    const recovered = await findCheckpointByKey(
      box,
      request.idempotencyKey,
      signal
    );
    if (recovered === undefined) {
      return {
        state: "undecided",
        message: "Sandbox checkpoint inventory is unavailable",
      };
    }
    if (!recovered) return { state: "absent" };
    if (recovered.marker.requestDigest !== request.requestDigest) {
      return {
        state: "conflict",
        existingRequestDigest: recovered.marker.requestDigest,
      };
    }
    const record = checkpointRecordFromSnapshot(
      recovered.marker.request,
      recovered.snapshot
    );
    if (!record) {
      return {
        state: "undecided",
        message: "Sandbox checkpoint metadata is invalid",
      };
    }
    checkpoints.set(request.idempotencyKey, record);
    return { state: "known", record };
  };

  /** The fork equivalent of {@link resolveCheckpoint}. */
  const resolveFork = async (
    request: Pick<WorkspaceForkRequest, "idempotencyKey" | "requestDigest">,
    signal?: AbortSignal
  ): Promise<Resolved<ForkRecord>> => {
    const local = forks.get(request.idempotencyKey);
    if (local) {
      return local.request.requestDigest === request.requestDigest
        ? { state: "known", record: local }
        : {
            state: "conflict",
            existingRequestDigest: local.request.requestDigest,
          };
    }
    const recovered = await findForkByKey(
      client,
      box,
      provider,
      request.idempotencyKey,
      signal
    );
    if (recovered === undefined) {
      return {
        state: "undecided",
        message: "Sandbox child inventory is unavailable",
      };
    }
    if (!recovered) return { state: "absent" };
    if (recovered.marker.requestDigest !== request.requestDigest) {
      return {
        state: "conflict",
        existingRequestDigest: recovered.marker.requestDigest,
      };
    }
    const child = await completeForkChild(client, recovered.child, signal);
    if (!child) {
      return {
        state: "undecided",
        message: "Sandbox fork child identity is incomplete",
      };
    }
    const environment = await environmentFromChild(
      recovered.marker.request,
      child,
      provider,
      recovered.createdAt ?? child.createdAt,
      options.confidentialAttestationVerifier,
      signal
    );
    if (!environment) {
      return {
        state: "undecided",
        message: "Sandbox fork child identity is incomplete",
      };
    }
    const record = {
      request: recovered.marker.request,
      environment,
      child,
    };
    forks.set(request.idempotencyKey, record);
    return { state: "known", record };
  };

  const checkpoint = async (
    input: WorkspaceCheckpointRequest,
    operation?: { signal?: AbortSignal }
  ): Promise<WorkspaceCheckpointResult> => {
    const request = WorkspaceCheckpointRequestSchema.parse(input);
    assertCheckpointSource(request, provider, box.id);
    const known = await resolveCheckpoint(request, operation?.signal);
    if (known.state === "conflict") {
      return checkpointConflict(request, known.existingRequestDigest);
    }
    if (known.state === "undecided") {
      return checkpointUnknown(
        request,
        `${known.message}; retry after reconciliation`,
        true
      );
    }
    if (known.state === "known") {
      return checkpointSuccess(request, known.record.checkpoint, "replayed");
    }

    const tags = checkpointMarkerTags(request);
    let result: SandboxSnapshotResultLike;
    try {
      result = await awaitWithSignal(
        box.snapshot?.({ tags, idempotencyKey: request.idempotencyKey }),
        operation?.signal
      );
    } catch (error) {
      operation?.signal?.throwIfAborted();
      const conflict = await checkpointConflictFromRemote(
        box,
        request,
        operation?.signal
      );
      return (
        conflict ??
        checkpointUnknown(
          request,
          `Sandbox checkpoint outcome is unresolved: ${safeError(error)}`,
          true
        )
      );
    }
    if (!result || !validSnapshotResult(result)) {
      return checkpointUnknown(
        request,
        "Sandbox checkpoint returned no complete idempotent acknowledgement",
        true
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
        true
      );
    }
    const resultMarker = checkpointMarkerFromTags(
      result.tags,
      request.idempotencyKey
    );
    if (resultMarker && resultMarker.requestDigest !== request.requestDigest) {
      return checkpointConflict(request, resultMarker.requestDigest);
    }
    if (!resultMarker) {
      return checkpointUnknown(
        request,
        "Sandbox checkpoint acknowledgement omitted its provider recovery marker",
        true
      );
    }
    const record = checkpointRecordFromSnapshot(request, result);
    if (!record) {
      return checkpointUnknown(
        request,
        "Sandbox checkpoint acknowledgement contains invalid metadata",
        true
      );
    }
    checkpoints.set(request.idempotencyKey, record);
    return checkpointSuccess(
      request,
      record.checkpoint,
      result.idempotency.outcome
    );
  };

  const lookupCheckpoint = async (
    input: WorkspaceOperationLookupRequest,
    operation?: { signal?: AbortSignal }
  ): Promise<WorkspaceCheckpointLookupResult> => {
    const request = WorkspaceOperationLookupRequestSchema.parse(input);
    const known = await resolveCheckpoint(request, operation?.signal);
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
        operation?.signal
      );
      const settled = lookupOutcomeFromSandbox(lookup, "checkpoint");
      return settled.absent
        ? checkpointNotFound(request)
        : checkpointLookupUnknown(request, settled.message, settled.retryable);
    } catch (error) {
      operation?.signal?.throwIfAborted();
      return checkpointLookupUnknown(
        request,
        `Sandbox checkpoint lookup failed: ${safeError(error)}`,
        true
      );
    }
  };

  const deleteCheckpoint = async (
    input: WorkspaceCleanupRequest & { kind: "checkpoint" },
    operation?: { signal?: AbortSignal }
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
      provider,
      request.targetId,
      operation?.signal
    );
    if (blocking === undefined) {
      return cleanupUnknown(
        request,
        "Sandbox child inventory is unavailable; deletion was not attempted",
        true
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

    const known = await findManagedCheckpoint(
      box,
      provider,
      request.targetId,
      undefined,
      operation?.signal
    );
    if (known === "unknown") {
      return cleanupUnknown(
        request,
        "Sandbox checkpoint inventory is unavailable; deletion was not attempted",
        true
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
        operation?.signal
      );
    } catch (error) {
      operation?.signal?.throwIfAborted();
      return cleanupTransportFailure(
        request,
        `Sandbox checkpoint deletion failed: ${safeError(error)}`,
        true
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
        true
      );
    }
    const acknowledgement =
      outcome === "deleted"
        ? cleanupDeleted(request)
        : cleanupAlreadyAbsent(request);
    forgetRecords(
      checkpoints,
      (record) => record.snapshotId === request.targetId
    );
    cleanup.set(request.operationId, {
      requestDigest: request.requestDigest,
      acknowledgement,
    });
    return acknowledgement;
  };

  const fork = async (
    input: WorkspaceForkRequest,
    operation?: { signal?: AbortSignal }
  ): Promise<WorkspaceForkResult> => {
    const request = WorkspaceForkRequestSchema.parse(input);
    assertForkSource(request, provider, box.id);
    if (
      request.confidential?.requested === true &&
      (typeof options.confidentialAttestationVerifier !== "function" ||
        typeof box.getTeeAttestation !== "function")
    ) {
      return forkUnknown(
        request,
        "Confidential fork requires a trusted verifier and Sandbox attestation support",
        false
      );
    }
    const known = await resolveFork(request, operation?.signal);
    if (known.state === "conflict") {
      return forkConflict(request, known.existingRequestDigest);
    }
    if (known.state === "undecided") {
      return forkUnknown(
        request,
        `${known.message}; retry after reconciliation`,
        true
      );
    }
    if (known.state === "known") {
      return forkSuccess(request, known.record.environment, "replayed");
    }

    const checkpoint = [...checkpoints.values()].some(
      (record) =>
        canonicalCandidateDigest(record.checkpoint) ===
        canonicalCandidateDigest(request.checkpoint)
    )
      ? true
      : await findManagedCheckpoint(
          box,
          provider,
          request.checkpoint.checkpointId,
          request.checkpoint,
          operation?.signal
        );
    if (checkpoint !== true) {
      return forkUnknown(
        request,
        checkpoint === false
          ? "Requested checkpoint is absent"
          : "Sandbox checkpoint inventory is unavailable",
        true
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
        operation?.signal
      );
    } catch (error) {
      operation?.signal?.throwIfAborted();
      const conflict = await forkConflictFromRemote(
        client,
        box,
        provider,
        request,
        options.confidentialAttestationVerifier,
        operation?.signal
      );
      return (
        conflict ??
        forkUnknown(
          request,
          `Sandbox fork outcome is unresolved: ${safeError(error)}`,
          true
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
        true
      );
    }
    if (result.children.length !== 1 || result.complete !== true) {
      return forkUnknown(
        request,
        "Sandbox fork did not materialize exactly one complete child",
        true
      );
    }
    const returnedChild = result.children[0];
    const child = await completeForkChild(
      client,
      returnedChild,
      operation?.signal
    );
    if (!child) {
      const compensation =
        forkMarkerFromMetadata(returnedChild.metadata) === undefined
          ? await compensateUnmarkedForkChild(
              result,
              returnedChild,
              operation?.signal
            )
          : "not_attempted";
      const removed =
        compensation === "destroyed" || compensation === "already_absent";
      return forkUnknown(
        request,
        removed
          ? "Sandbox fork returned a child without a complete identity; the newly created child was removed"
          : compensation === "unconfirmed"
          ? "Sandbox fork returned a child without a complete identity; child cleanup was not confirmed"
          : "Sandbox fork returned a child without a complete identity",
        !removed
      );
    }
    const childMarker = forkMarkerFromMetadata(child.metadata);
    if (childMarker) {
      if (!markerBelongsToSource(childMarker, provider, box.id)) {
        return forkUnknown(
          request,
          "Sandbox fork returned a child marked for another source",
          true
        );
      }
      if (
        childMarker.idempotencyKey !== request.idempotencyKey ||
        childMarker.requestDigest !== request.requestDigest
      ) {
        return forkConflict(request, childMarker.requestDigest);
      }
    }
    if (!childMarker) {
      const compensation = await compensateUnmarkedForkChild(
        result,
        child,
        operation?.signal
      );
      const removed =
        compensation === "destroyed" || compensation === "already_absent";
      return forkUnknown(
        request,
        removed
          ? "Sandbox fork acknowledgement omitted its provider recovery marker; the newly created child was removed"
          : compensation === "unconfirmed"
          ? "Sandbox fork acknowledgement omitted its provider recovery marker; child cleanup was not confirmed"
          : "Sandbox fork acknowledgement omitted its provider recovery marker",
        !removed
      );
    }
    const environment = await environmentFromChild(
      request,
      child,
      provider,
      child.createdAt,
      options.confidentialAttestationVerifier,
      operation?.signal
    );
    if (!environment) {
      return forkUnknown(
        request,
        "Sandbox fork returned a child without a valid identity",
        true
      );
    }
    const record = { request, environment, child };
    forks.set(request.idempotencyKey, record);
    return forkSuccess(request, environment, result.idempotency.outcome);
  };

  const lookupFork = async (
    input: WorkspaceOperationLookupRequest,
    operation?: { signal?: AbortSignal }
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
        operation?.signal
      );
      const settled = lookupOutcomeFromSandbox(lookup, "fork");
      return settled.absent
        ? forkNotFound(request)
        : forkLookupUnknown(request, settled.message, settled.retryable);
    } catch (error) {
      operation?.signal?.throwIfAborted();
      return forkLookupUnknown(
        request,
        `Sandbox fork lookup failed: ${safeError(error)}`,
        true
      );
    }
  };

  const destroyFork = async (
    input: WorkspaceCleanupRequest & { kind: "fork" },
    operation?: { signal?: AbortSignal }
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
      (record) => record.environment.environmentId === request.targetId
    );
    const child =
      localFork?.child ??
      (await findForkChildById(
        client,
        box,
        provider,
        request.targetId,
        operation?.signal
      ));
    if (child === undefined) {
      return cleanupUnknown(
        request,
        "Sandbox child inventory is unavailable; destruction was not attempted",
        true
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
      result = (await awaitWithSignal(
        child.delete?.(),
        operation?.signal
      )) as SandboxDeleteAcknowledgementLike;
    } catch (error) {
      operation?.signal?.throwIfAborted();
      return cleanupTransportFailure(
        request,
        `Sandbox fork destruction failed: ${safeError(error)}`,
        true
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
        true
      );
    }
    const acknowledgement =
      outcome === "destroyed"
        ? cleanupDeleted(request)
        : cleanupAlreadyAbsent(request);
    forgetRecords(
      forks,
      (record) => record.environment.environmentId === request.targetId
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
  client: SandboxClientLike
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
function forgetRecords<T>(
  records: Map<string, T>,
  matches: (record: T) => boolean
): void {
  for (const [key, record] of records) {
    if (matches(record)) records.delete(key);
  }
}

function assertCheckpointSource(
  request: WorkspaceCheckpointRequest,
  provider: string,
  environmentId: string
): void {
  if (
    request.source.provider !== provider ||
    request.source.environmentId !== environmentId
  ) {
    throw new Error(
      "Tangle checkpoint source does not belong to this environment"
    );
  }
}

function assertForkSource(
  request: WorkspaceForkRequest,
  provider: string,
  environmentId: string
): void {
  if (
    request.checkpoint.provider !== provider ||
    request.checkpoint.source.provider !== provider ||
    request.checkpoint.source.environmentId !== environmentId
  ) {
    throw new Error(
      "Tangle fork checkpoint does not belong to this environment"
    );
  }
}

function assertCleanupProvider(
  request: WorkspaceCleanupRequest,
  provider: string
): void {
  if (request.provider !== provider) {
    throw new Error("Tangle cleanup provider does not match this provider");
  }
}

function checkpointRecordFromSnapshot(
  request: WorkspaceCheckpointRequest,
  snapshot: SandboxSnapshotResultLike | SandboxSnapshotInfoLike
): CheckpointRecord | undefined {
  try {
    const createdAt = isoDate(snapshot.createdAt);
    const checkpoint = WorkspaceCheckpointRefSchema.parse({
      checkpointId: boundedIdentifier(
        snapshot.snapshotId,
        "Tangle checkpoint id"
      ),
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
  signal?: AbortSignal
): Promise<ForkedEnvironmentRef | undefined> {
  signal?.throwIfAborted();
  const environmentId = safeIdentifier(child.id);
  if (
    !environmentId ||
    environmentId === request.checkpoint.source.environmentId
  ) {
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
      signal
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
    ...(attestation === undefined
      ? {}
      : { confidentialAttestation: attestation }),
    ...(attestation === undefined ? {} : { confidential: true }),
    ...(metadata === undefined ? {} : { metadata }),
  });
  signal?.throwIfAborted();
  return environment.success ? environment.data : undefined;
}

async function confidentialAttestationForChild(
  request: WorkspaceForkRequest,
  child: SandboxInstanceLike,
  provider: string,
  verifier: TangleConfidentialAttestationVerifier,
  signal?: AbortSignal
): Promise<ConfidentialAttestation | undefined> {
  const confidential = ConfidentialExecutionRequestSchema.parse(
    request.confidential
  );
  if (
    !confidential.requested ||
    typeof child.getTeeAttestation !== "function"
  ) {
    return undefined;
  }
  let response: SandboxTeeAttestationResponseLike;
  try {
    response = await awaitWithSignal(
      child.getTeeAttestation({ attestationNonce: confidential.nonce }),
      signal
    );
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
  if (
    !response ||
    response.sandbox_id !== child.id ||
    !validTeeReport(response.attestation) ||
    safeIdentifier(response.attestationNonce) === undefined ||
    response.attestationNonce !== confidential.nonce
  ) {
    return undefined;
  }
  const measurement = sha256Bytes(
    Uint8Array.from(response.attestation.measurement)
  );
  const quote = encodeTangleConfidentialAttestationQuote(response.attestation);
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
    const provisionalResult =
      ConfidentialAttestationSchema.safeParse(provisional);
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
    (verification.measurement !== undefined &&
      verification.measurement !== measurement)
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
  report: SandboxTeeAttestationResponseLike["attestation"] | undefined
): report is NonNullable<SandboxTeeAttestationResponseLike["attestation"]> {
  return (
    !!report &&
    safeString(report.tee_type) !== undefined &&
    Array.isArray(report.evidence) &&
    report.evidence.length <= MAX_TEE_EVIDENCE_BYTES &&
    report.evidence.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255
    ) &&
    Array.isArray(report.measurement) &&
    report.measurement.length <= MAX_TEE_MEASUREMENT_BYTES &&
    report.measurement.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255
    ) &&
    Number.isFinite(report.timestamp) &&
    report.timestamp > 0
  );
}

function validSnapshotResult(
  result: SandboxSnapshotResultLike | undefined
): result is SandboxSnapshotResultLike {
  return (
    !!result &&
    safeIdentifier(result.snapshotId) !== undefined &&
    validDate(result.createdAt) &&
    Array.isArray(result.tags) &&
    result.tags.every((tag) => safeString(tag) !== undefined)
  );
}

function validSnapshotInfo(
  snapshot: SandboxSnapshotInfoLike,
  sandboxId?: string
): boolean {
  return (
    validSnapshotResult(snapshot) &&
    safeIdentifier(snapshot.sandboxId) !== undefined &&
    (sandboxId === undefined || snapshot.sandboxId === sandboxId)
  );
}

function validForkResult(
  result: SandboxForkAcknowledgementLike | undefined
): result is SandboxForkAcknowledgementLike {
  return (
    !!result &&
    Array.isArray(result.children) &&
    result.children.every(
      (child) =>
        child !== null &&
        typeof child === "object" &&
        safeIdentifier(child.id) !== undefined
    ) &&
    result.requestedCount === 1 &&
    result.materializedCount === result.children.length &&
    typeof result.complete === "boolean"
  );
}

type SnapshotOperationResult = {
  snapshotId: string;
  createdAt: Date | string;
};

type ForkOperationChildResult = {
  sandboxId?: string;
  id?: string;
  createdAt: Date | string;
};

function validOperationRecord(
  value: unknown
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validOperationDate(value: unknown): value is Date | string {
  return (
    (typeof value === "string" || value instanceof Date) && validDate(value)
  );
}

function validSnapshotOperationResult(
  value: unknown
): value is SnapshotOperationResult {
  return (
    validOperationRecord(value) &&
    safeIdentifier(value.snapshotId) !== undefined &&
    validOperationDate(value.createdAt)
  );
}

function validForkOperationChildResult(
  value: unknown
): value is ForkOperationChildResult {
  return (
    validOperationRecord(value) &&
    safeIdentifier(value.sandboxId ?? value.id) !== undefined &&
    validOperationDate(value.createdAt)
  );
}

function checkpointMarkerTags(request: WorkspaceCheckpointRequest): string[] {
  const marker: CheckpointMarker = {
    version: 1,
    kind: "checkpoint",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    request,
  };
  return markerTags(
    "checkpoint",
    request.idempotencyKey,
    request.requestDigest,
    marker
  );
}

/** Rebuild the exact tags used by the release before the current safe format. */
function legacyCheckpointMarkerTags(
  request: WorkspaceCheckpointRequest
): string[] {
  const marker: CheckpointMarker = {
    version: 1,
    kind: "checkpoint",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    request,
  };
  const encoded = encodeJson(marker);
  if (encoded === undefined)
    throw new Error("workspace marker is not JSON serializable");
  const base = `${LEGACY_MARKER_PREFIX}:checkpoint`;
  const chunks = splitIntoChunks(encoded, LEGACY_MARKER_CHUNK_SIZE);
  if (chunks.length > MAX_MARKER_CHUNKS) {
    throw new Error("workspace marker exceeds the recovery bound");
  }
  return [
    `${base}:key:${encodeText(request.idempotencyKey)}`,
    `${base}:digest:${request.requestDigest}`,
    ...chunks.map(
      (chunk, index) => `${base}:material:${index}:${chunks.length}:${chunk}`
    ),
  ];
}

function forkMarkerMetadata(
  request: WorkspaceForkRequest
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
async function checkpointOperationLookup(
  box: SandboxInstanceLike,
  marker: CheckpointMarker,
  signal?: AbortSignal
): Promise<SandboxWorkspaceOperationLookupLike | undefined> {
  const lookup = await awaitWithSignal(
    box.getSnapshotOperation?.(marker.idempotencyKey, {
      tags: marker.legacy
        ? legacyCheckpointMarkerTags(marker.request)
        : checkpointMarkerTags(marker.request),
    }),
    signal
  );
  return lookup;
}

async function checkpointOperationSucceeded(
  box: SandboxInstanceLike,
  marker: CheckpointMarker,
  signal?: AbortSignal
): Promise<boolean> {
  const lookup = await checkpointOperationLookup(box, marker, signal);
  return (
    lookup?.outcome === "found" &&
    lookup.kind === "checkpoint" &&
    lookup.state === "succeeded"
  );
}

/** The fork equivalent of {@link checkpointOperationSucceeded}. */
async function forkOperationLookup(
  box: SandboxInstanceLike,
  marker: ForkMarker,
  signal?: AbortSignal
): Promise<SandboxWorkspaceOperationLookupLike | undefined> {
  const lookup = await awaitWithSignal(
    box.getForkOperation?.(marker.idempotencyKey, {
      count: 1,
      metadata: forkMarkerMetadata(marker.request),
    }),
    signal
  );
  return lookup;
}

async function forkOperationSucceeded(
  box: SandboxInstanceLike,
  marker: ForkMarker,
  signal?: AbortSignal
): Promise<boolean> {
  const lookup = await forkOperationLookup(box, marker, signal);
  return (
    lookup?.outcome === "found" &&
    lookup.kind === "fork" &&
    lookup.state === "succeeded"
  );
}

function markerTags(
  kind: "checkpoint" | "fork",
  idempotencyKey: string,
  requestDigest: string,
  marker: CheckpointMarker
): string[] {
  const encoded = encodeJson(marker);
  if (encoded === undefined)
    throw new Error("workspace marker is not JSON serializable");
  const base = `${MARKER_PREFIX}-${kind}`;
  const chunks = split(encoded);
  if (chunks.length > MAX_MARKER_CHUNKS) {
    throw new Error("workspace marker exceeds the recovery bound");
  }
  return [
    `${base}-key-${markerKeyDigest(idempotencyKey).replace(":", "-")}`,
    `${base}-digest-${requestDigest.replace(":", "-")}`,
    ...chunks.map(
      (chunk, index) => `${base}-material-${index}-${chunks.length}-${chunk}`
    ),
  ].map((tag) => {
    if (Buffer.byteLength(tag, "utf8") > MAX_MARKER_TAG_LENGTH) {
      throw new Error("workspace marker tag exceeds the platform bound");
    }
    return tag;
  });
}

async function findCheckpointByKey(
  box: SandboxInstanceLike,
  key: string,
  signal?: AbortSignal
): Promise<
  | { snapshot: SandboxSnapshotInfoLike; marker: CheckpointMarker }
  | null
  | undefined
> {
  let snapshots: SandboxSnapshotInfoLike[];
  try {
    const listed = await awaitWithSignal(box.listSnapshots?.(), signal);
    if (!Array.isArray(listed)) return undefined;
    snapshots = listed;
  } catch {
    signal?.throwIfAborted();
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
      const lookup = await checkpointOperationLookup(box, marker, signal);
      if (
        lookup?.outcome === "found" &&
        lookup.kind === "checkpoint" &&
        lookup.state === "succeeded"
      ) {
        const authoritative = snapshotFromOperationResult(snapshot, lookup);
        if (authoritative === undefined) return undefined;
        return { snapshot: authoritative, marker };
      }
      unresolved = true;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  return unresolved ? undefined : null;
}

/**
 * Prefer the durable operation result over inventory metadata.
 *
 * Snapshot inventory and the operation ledger can expose different creation
 * timestamps. The ledger result is the acknowledgement returned by the
 * idempotent operation, so recovery must rebuild the exact checkpoint ref
 * from it when the service provides that result.
 */
function snapshotFromOperationResult(
  snapshot: SandboxSnapshotInfoLike,
  lookup: SandboxWorkspaceOperationLookupLike
): SandboxSnapshotInfoLike | undefined {
  if (lookup.result === undefined) return snapshot;
  if (
    !validSnapshotOperationResult(lookup.result) ||
    lookup.result.snapshotId !== snapshot.snapshotId
  ) {
    return undefined;
  }
  return { ...snapshot, createdAt: lookup.result.createdAt };
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
  signal?: AbortSignal
): Promise<true | false | "unknown"> {
  try {
    const snapshots = await awaitWithSignal(box.listSnapshots?.(), signal);
    if (!Array.isArray(snapshots) || snapshots.length > MAX_LIST_RESULTS) {
      return "unknown";
    }
    const snapshot = snapshots.find((candidate) => candidate.snapshotId === id);
    if (!snapshot) return false;
    if (!validSnapshotInfo(snapshot, box.id)) return "unknown";
    const marker = checkpointMarkerFromTags(
      snapshot.tags,
      expected?.idempotencyKey
    );
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
    return (await checkpointOperationSucceeded(box, marker, signal))
      ? true
      : "unknown";
  } catch {
    signal?.throwIfAborted();
    return "unknown";
  }
}

async function findForkByKey(
  client: SandboxClientLike,
  box: SandboxInstanceLike,
  provider: string,
  key: string,
  signal?: AbortSignal
): Promise<
  | (RecoveredForkChild & { marker: ForkMarker })
  | null
  | undefined
> {
  const candidates = await listMarkedForkChildren(
    client,
    box,
    provider,
    key,
    signal
  );
  if (candidates === undefined) return undefined;
  let unresolved = false;
  for (const candidate of candidates) {
    try {
      const lookup = await forkOperationLookup(box, candidate.marker, signal);
      if (
        lookup?.outcome === "found" &&
        lookup.kind === "fork" &&
        lookup.state === "succeeded"
      ) {
        const authoritative = childFromOperationResult(candidate.child, lookup);
        if (authoritative === undefined) return undefined;
        return { ...authoritative, marker: candidate.marker };
      }
      unresolved = true;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  return unresolved ? undefined : null;
}

/**
 * Prefer the durable fork result over account-inventory metadata.
 *
 * Fork inventory can report a child timestamp from a later registry read. The
 * operation ledger stores the original child acknowledgement, which is the
 * stable value required to replay one exact fork reference after a restart.
 */
function childFromOperationResult(
  child: SandboxInstanceLike,
  lookup: SandboxWorkspaceOperationLookupLike
): RecoveredForkChild | undefined {
  if (lookup.result === undefined) {
    return { child, createdAt: child.createdAt };
  }
  const result = lookup.result;
  if (!validOperationRecord(result)) return undefined;
  const children = result.children;
  if (!Array.isArray(children)) return undefined;
  const operationChild = children.find(
    (candidate): candidate is ForkOperationChildResult =>
      validForkOperationChildResult(candidate) &&
      (candidate.sandboxId ?? candidate.id) === child.id
  );
  if (!operationChild) return undefined;
  return { child, createdAt: operationChild.createdAt };
}

async function findForkChildById(
  client: SandboxClientLike,
  box: SandboxInstanceLike,
  provider: string,
  id: string,
  signal?: AbortSignal
): Promise<SandboxInstanceLike | null | undefined> {
  try {
    if (typeof client.get !== "function") return undefined;
    const child = await awaitWithSignal(
      client.get(id, signal ? { signal } : undefined),
      signal
    );
    if (child === null) return null;
    if (child.id !== id) return undefined;
    const marker = forkMarkerFromMetadata(child.metadata);
    if (!marker || !markerBelongsToSource(marker, provider, box.id))
      return undefined;
    return (await forkOperationSucceeded(box, marker, signal))
      ? child
      : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

/**
 * Resolve a complete child identity when an acknowledgement omits durable data.
 *
 * A branch response can precede a richer registry read during a rolling
 * deployment. Recover the exact child when its creation time or provider
 * marker is absent. Never invent either field from the request.
 */
async function completeForkChild(
  client: SandboxClientLike,
  child: SandboxInstanceLike,
  signal?: AbortSignal
): Promise<SandboxInstanceLike | undefined> {
  if (
    child.createdAt !== undefined &&
    forkMarkerFromMetadata(child.metadata) !== undefined
  ) {
    return child;
  }
  if (
    typeof client.get !== "function" ||
    safeIdentifier(child.id) === undefined
  ) {
    return undefined;
  }
  try {
    const resolved = await awaitWithSignal(
      client.get(child.id, signal ? { signal } : undefined),
      signal
    );
    if (
      !resolved ||
      resolved.id !== child.id ||
      resolved.createdAt === undefined
    ) {
      return undefined;
    }
    return resolved;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

type ForkCompensation =
  | "destroyed"
  | "already_absent"
  | "unconfirmed"
  | "not_attempted";

/** Remove only a child this exact call confirmed it created. */
async function compensateUnmarkedForkChild(
  result: SandboxForkAcknowledgementLike,
  child: SandboxInstanceLike,
  signal?: AbortSignal
): Promise<ForkCompensation> {
  if (result.idempotency?.outcome !== "created") return "not_attempted";
  if (typeof child.delete !== "function") return "unconfirmed";
  try {
    const acknowledgement = (await awaitWithSignal(
      child.delete(),
      signal
    )) as SandboxDeleteAcknowledgementLike;
    if (
      acknowledgement?.sandboxId !== child.id ||
      (acknowledgement.outcome !== "destroyed" &&
        acknowledgement.outcome !== "already_absent")
    ) {
      return "unconfirmed";
    }
    return acknowledgement.outcome;
  } catch {
    signal?.throwIfAborted();
    return "unconfirmed";
  }
}

async function findBlockingForks(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  provider: string,
  checkpointId: string,
  signal?: AbortSignal
): Promise<string[] | undefined> {
  const candidates = await listMarkedForkChildren(
    client,
    box,
    provider,
    undefined,
    signal
  );
  if (candidates === undefined) return undefined;
  const blocking = new Set<string>();
  for (const { child, marker } of candidates) {
    if (marker.request.checkpoint.checkpointId !== checkpointId) continue;
    try {
      // A candidate that cannot be confirmed leaves the dependency set
      // unknown, so cleanup must not proceed on a partial answer.
      if (!(await forkOperationSucceeded(box, marker, signal)))
        return undefined;
      blocking.add(child.id);
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  return [...blocking].sort();
}

/**
 * Read the complete account inventory through Sandbox offset pages.
 *
 * Sandbox returns only an array, so a short page is the terminal marker. A
 * full page requires another request; stopping there would make recovery
 * report a false absence. Duplicate ids or an inventory above the safety
 * bound make completeness unknowable and therefore fail closed.
 */
async function listAllSandboxChildren(
  client: SandboxClientLike,
  signal?: AbortSignal
): Promise<SandboxInstanceLike[] | undefined> {
  if (typeof client.list !== "function") return undefined;
  const children: SandboxInstanceLike[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (true) {
    signal?.throwIfAborted();
    let page: SandboxInstanceLike[];
    try {
      const listed = await awaitWithSignal(
        client.list({
          scope: "all",
          limit: SANDBOX_LIST_PAGE_SIZE,
          offset,
        }),
        signal
      );
      if (!Array.isArray(listed) || listed.length > SANDBOX_LIST_PAGE_SIZE) {
        return undefined;
      }
      page = listed;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }

    for (const child of page) {
      if (
        !child ||
        typeof child !== "object" ||
        safeIdentifier(child.id) === undefined ||
        seen.has(child.id)
      ) {
        return undefined;
      }
      seen.add(child.id);
    }

    if (children.length + page.length > MAX_LIST_RESULTS) return undefined;
    children.push(...page);
    if (page.length < SANDBOX_LIST_PAGE_SIZE) return children;
    if (offset > Number.MAX_SAFE_INTEGER - SANDBOX_LIST_PAGE_SIZE) {
      return undefined;
    }
    offset += SANDBOX_LIST_PAGE_SIZE;
  }
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
  signal?: AbortSignal
): Promise<{ child: SandboxInstanceLike; marker: ForkMarker }[] | undefined> {
  const children = await listAllSandboxChildren(client, signal);
  if (children === undefined) return undefined;
  const marked: { child: SandboxInstanceLike; marker: ForkMarker }[] = [];
  for (const child of children) {
    if (
      !child ||
      typeof child !== "object" ||
      safeIdentifier(child.id) === undefined
    ) {
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
  sourceEnvironmentId: string
): boolean {
  return (
    marker.request.checkpoint.provider === provider &&
    marker.request.checkpoint.source.environmentId === sourceEnvironmentId
  );
}

function checkpointMarkerFromTags(
  tags: string[] | undefined,
  key?: string
): CheckpointMarker | undefined {
  if (
    !Array.isArray(tags) ||
    tags.length > MAX_MARKER_CHUNKS + 3 ||
    !tags.every((tag) => safeString(tag) !== undefined)
  ) {
    return undefined;
  }

  const currentBase = `${MARKER_PREFIX}-checkpoint`;
  const legacyBase = `${LEGACY_MARKER_PREFIX}:checkpoint`;
  const hasCurrentTags = tags.some((tag) => tag.startsWith(`${currentBase}-`));
  const hasLegacyTags = tags.some((tag) => tag.startsWith(`${legacyBase}:`));
  if (hasCurrentTags === hasLegacyTags) return undefined;
  if (hasLegacyTags)
    return legacyCheckpointMarkerFromTags(tags, key, legacyBase);
  if (
    tags.some((tag) => Buffer.byteLength(tag, "utf8") > MAX_MARKER_TAG_LENGTH)
  ) {
    return undefined;
  }
  return currentCheckpointMarkerFromTags(tags, key, currentBase);
}

function currentCheckpointMarkerFromTags(
  tags: string[],
  key: string | undefined,
  base: string
): CheckpointMarker | undefined {
  const keyTag = tags.find((tag) => tag.startsWith(`${base}-key-`));
  if (
    keyTag &&
    key !== undefined &&
    keyTag.slice(`${base}-key-`.length) !==
      markerKeyDigest(key).replace(":", "-")
  ) {
    return undefined;
  }
  const chunks = tags
    .map((tag) => {
      const match = tag.match(
        new RegExp(
          `^${escapeRegExp(base)}-material-(\\d+)-(\\d+)-([A-Za-z0-9_-]+)$`
        )
      );
      return match
        ? { index: Number(match[1]), total: Number(match[2]), chunk: match[3] }
        : undefined;
    })
    .filter(
      (value): value is { index: number; total: number; chunk: string } =>
        value !== undefined
    )
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
        chunk.total !== chunks[0].total
    )
  ) {
    return undefined;
  }
  const decoded = decodeJson(chunks.map((chunk) => chunk.chunk).join(""));
  return checkpointMarkerFromUnknown(decoded, key);
}

function legacyCheckpointMarkerFromTags(
  tags: string[],
  key: string | undefined,
  base: string
): CheckpointMarker | undefined {
  const keyTag = tags.find((tag) => tag.startsWith(`${base}:key:`));
  if (
    keyTag &&
    key !== undefined &&
    decodeText(keyTag.slice(`${base}:key:`.length)) !== key
  ) {
    return undefined;
  }
  const chunks = tags
    .map((tag) => {
      const match = tag.match(
        new RegExp(
          `^${escapeRegExp(base)}:material:(\\d+):(\\d+):([A-Za-z0-9_-]+)$`
        )
      );
      return match
        ? { index: Number(match[1]), total: Number(match[2]), chunk: match[3] }
        : undefined;
    })
    .filter(
      (value): value is { index: number; total: number; chunk: string } =>
        value !== undefined
    )
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
        chunk.total !== chunks[0].total
    )
  ) {
    return undefined;
  }
  const decoded = decodeJson(chunks.map((chunk) => chunk.chunk).join(""));
  return checkpointMarkerFromUnknown(decoded, key, true);
}

function checkpointMarkerFromUnknown(
  value: unknown,
  key?: string,
  legacy = false
): CheckpointMarker | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Partial<CheckpointMarker>;
  if (
    parsed.version !== 1 ||
    parsed.kind !== "checkpoint" ||
    typeof parsed.idempotencyKey !== "string" ||
    typeof parsed.requestDigest !== "string"
  )
    return undefined;
  if (key !== undefined && parsed.idempotencyKey !== key) return undefined;
  const request = WorkspaceCheckpointRequestSchema.safeParse(parsed.request);
  if (
    !request.success ||
    request.data.idempotencyKey !== parsed.idempotencyKey ||
    request.data.requestDigest !== parsed.requestDigest
  )
    return undefined;
  return {
    version: 1,
    kind: "checkpoint",
    idempotencyKey: parsed.idempotencyKey,
    requestDigest: parsed.requestDigest,
    request: request.data,
    ...(legacy ? { legacy: true } : {}),
  };
}

function forkMarkerFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key?: string
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
  if (
    parsed.version !== 1 ||
    parsed.kind !== "fork" ||
    typeof parsed.idempotencyKey !== "string" ||
    typeof parsed.requestDigest !== "string"
  )
    return undefined;
  if (key !== undefined && parsed.idempotencyKey !== key) return undefined;
  const request = WorkspaceForkRequestSchema.safeParse(parsed.request);
  if (
    !request.success ||
    request.data.idempotencyKey !== parsed.idempotencyKey ||
    request.data.requestDigest !== parsed.requestDigest
  )
    return undefined;
  return {
    version: 1,
    kind: "fork",
    idempotencyKey: parsed.idempotencyKey,
    requestDigest: parsed.requestDigest,
    request: request.data,
  };
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
  signal?: AbortSignal
): Promise<WorkspaceCheckpointResult | undefined> {
  signal?.throwIfAborted();
  const recovered = await findCheckpointByKey(
    box,
    request.idempotencyKey,
    signal
  );
  signal?.throwIfAborted();
  if (!recovered) return undefined;
  if (recovered.marker.requestDigest !== request.requestDigest) {
    return checkpointConflict(request, recovered.marker.requestDigest);
  }
  const record = checkpointRecordFromSnapshot(
    recovered.marker.request,
    recovered.snapshot
  );
  return record === undefined
    ? undefined
    : checkpointSuccess(request, record.checkpoint, "replayed");
}

/** The fork equivalent of {@link checkpointConflictFromRemote}. */
async function forkConflictFromRemote(
  client: SandboxClientLike,
  box: SandboxInstanceLike,
  provider: string,
  request: WorkspaceForkRequest,
  verifier: TangleConfidentialAttestationVerifier | undefined,
  signal?: AbortSignal
): Promise<WorkspaceForkResult | undefined> {
  const recovered = await findForkByKey(
    client,
    box,
    provider,
    request.idempotencyKey,
    signal
  );
  if (!recovered) return undefined;
  if (recovered.marker.requestDigest !== request.requestDigest) {
    return forkConflict(request, recovered.marker.requestDigest);
  }
  const child = await completeForkChild(client, recovered.child, signal);
  if (!child) return undefined;
  const environment = await environmentFromChild(
    recovered.marker.request,
    child,
    provider,
    recovered.createdAt ?? child.createdAt,
    verifier,
    signal
  );
  return environment === undefined
    ? undefined
    : forkSuccess(request, environment, "replayed");
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
  kind: "checkpoint" | "fork"
): { absent: true } | { absent: false; message: string; retryable: boolean } {
  if (!lookup || lookup.kind !== kind) {
    return {
      absent: false,
      message: `Sandbox returned no ${kind} lookup`,
      retryable: true,
    };
  }
  if (lookup.outcome === "conflict") {
    return {
      absent: false,
      message:
        "Sandbox found a conflicting operation without provider identity",
      retryable: false,
    };
  }
  if (
    lookup.outcome !== "not_found" &&
    (lookup.outcome === "unknown" || lookup.state !== "succeeded")
  ) {
    return {
      absent: false,
      message: `Sandbox ${kind} operation is not decided`,
      retryable: true,
    };
  }
  return { absent: true };
}

function checkpointSuccess(
  request: WorkspaceCheckpointRequest,
  checkpoint: WorkspaceCheckpointRef,
  status: "created" | "replayed"
): WorkspaceCheckpointResult {
  return WorkspaceCheckpointResultSchema.parse({
    status,
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    checkpoint,
  });
}

function checkpointConflict(
  request: WorkspaceCheckpointRequest,
  existingRequestDigest: string
): WorkspaceCheckpointResult {
  return WorkspaceCheckpointResultSchema.parse({
    status: "conflict",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    existingRequestDigest,
  });
}

function checkpointUnknown(
  request: WorkspaceCheckpointRequest,
  message: string,
  retryable: boolean
): WorkspaceCheckpointResult {
  return WorkspaceCheckpointResultSchema.parse({
    status: "unknown",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    message: boundedString(message, "Tangle checkpoint error"),
    retryable,
  });
}

function checkpointFound(
  request: WorkspaceOperationLookupRequest,
  checkpoint: WorkspaceCheckpointRef
): WorkspaceCheckpointLookupResult {
  return WorkspaceCheckpointLookupResultSchema.parse({
    status: "found",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    checkpoint,
  });
}

function checkpointNotFound(
  request: WorkspaceOperationLookupRequest
): WorkspaceCheckpointLookupResult {
  return WorkspaceCheckpointLookupResultSchema.parse({
    status: "not_found",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
  });
}

function checkpointLookupConflict(
  request: WorkspaceOperationLookupRequest,
  existingRequestDigest: string
): WorkspaceCheckpointLookupResult {
  return WorkspaceCheckpointLookupResultSchema.parse({
    status: "conflict",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    existingRequestDigest,
  });
}

function checkpointLookupUnknown(
  request: WorkspaceOperationLookupRequest,
  message: string,
  retryable: boolean
): WorkspaceCheckpointLookupResult {
  return WorkspaceCheckpointLookupResultSchema.parse({
    status: "unknown",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    message: boundedString(message, "Tangle checkpoint lookup error"),
    retryable,
  });
}

function forkSuccess(
  request: WorkspaceForkRequest,
  environment: ForkedEnvironmentRef,
  status: "created" | "replayed"
): WorkspaceForkResult {
  return WorkspaceForkResultSchema.parse({
    status,
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    environment,
  });
}

function forkConflict(
  request: WorkspaceForkRequest,
  existingRequestDigest: string
): WorkspaceForkResult {
  return WorkspaceForkResultSchema.parse({
    status: "conflict",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    existingRequestDigest,
  });
}

function forkUnknown(
  request: WorkspaceForkRequest,
  message: string,
  retryable: boolean
): WorkspaceForkResult {
  return WorkspaceForkResultSchema.parse({
    status: "unknown",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    message: boundedString(message, "Tangle fork error"),
    retryable,
  });
}

function forkFound(
  request: WorkspaceOperationLookupRequest,
  environment: ForkedEnvironmentRef
): WorkspaceForkLookupResult {
  return WorkspaceForkLookupResultSchema.parse({
    status: "found",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    environment,
  });
}

function forkNotFound(
  request: WorkspaceOperationLookupRequest
): WorkspaceForkLookupResult {
  return WorkspaceForkLookupResultSchema.parse({
    status: "not_found",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
  });
}

function forkLookupConflict(
  request: WorkspaceOperationLookupRequest,
  existingRequestDigest: string
): WorkspaceForkLookupResult {
  return WorkspaceForkLookupResultSchema.parse({
    status: "conflict",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    existingRequestDigest,
  });
}

function forkLookupUnknown(
  request: WorkspaceOperationLookupRequest,
  message: string,
  retryable: boolean
): WorkspaceForkLookupResult {
  return WorkspaceForkLookupResultSchema.parse({
    status: "unknown",
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    message: boundedString(message, "Tangle fork lookup error"),
    retryable,
  });
}

function cleanupDeleted(
  request: WorkspaceCleanupRequest
): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({
    ...request,
    status: "deleted",
  });
}

function cleanupAlreadyAbsent(
  request: WorkspaceCleanupRequest
): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({
    ...request,
    status: "already_absent",
  });
}

function cleanupConflict(
  request: WorkspaceCleanupRequest,
  existingRequestDigest: string
): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({
    ...request,
    status: "conflict",
    existingRequestDigest,
    message: "Cleanup operation id is bound to another target",
  });
}

function cleanupInUse(
  request: WorkspaceCleanupRequest,
  blockingTargetIds: string[]
): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({
    ...request,
    status: "in_use",
    blockingTargetIds,
    message: "Checkpoint is still referenced by forked environments",
  });
}

function cleanupUnknown(
  request: WorkspaceCleanupRequest,
  message: string,
  retryable: boolean
): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({
    ...request,
    status: "unknown",
    message: boundedString(message, "Tangle cleanup error"),
    retryable,
  });
}

function cleanupTransportFailure(
  request: WorkspaceCleanupRequest,
  message: string,
  retryable: boolean
): WorkspaceCleanupAcknowledgement {
  return WorkspaceCleanupAcknowledgementSchema.parse({
    ...request,
    status: "transport_failure",
    message: boundedString(message, "Tangle cleanup transport error"),
    retryable,
  });
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Sandbox returned an invalid workspace timestamp");
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
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  )
    return undefined;
  return value;
}

function safeString(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_LENGTH
  )
    return undefined;
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
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return encodeText(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function markerKeyDigest(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
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
    return JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown;
  } catch {
    return undefined;
  }
}

function split(value: string): string[] {
  return splitIntoChunks(value, MARKER_CHUNK_SIZE);
}

function splitIntoChunks(value: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
