import {
  WorkspaceCheckpointRefSchema,
  canonicalCandidateDigest,
} from "@tangle-network/agent-interface";
import type {
  WorkspaceCheckpointRef,
  WorkspaceCheckpointRequest,
} from "@tangle-network/agent-interface";
import {
  awaitWithSignal,
  boundedIdentifier,
  MAX_LIST_RESULTS,
  SANDBOX_LIST_PAGE_SIZE,
  cloneJson,
  safeIdentifier,
  safeString,
} from "./tangle-contract-safety.js";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
  SandboxSnapshotInfoLike,
  SandboxSnapshotResultLike,
  SandboxWorkspaceOperationLookupLike,
} from "./tangle-types.js";
import {
  checkpointMarkerTags,
  legacyCheckpointMarkerTags,
  forkMarkerMetadata,
  markerBelongsToSource,
  checkpointMarkerBelongsToSource,
  checkpointMarkerFromTags,
  forkMarkerFromMetadata,
} from "./tangle-workspace-markers.js";
import type {
  CheckpointMarker,
  ForkMarker,
} from "./tangle-workspace-markers.js";

export interface CheckpointRecord {
  request: WorkspaceCheckpointRequest;
  checkpoint: WorkspaceCheckpointRef;
  snapshotId: string;
}

interface RecoveredForkChild {
  child: SandboxInstanceLike;
  createdAt: Date | string | undefined;
}

type CheckpointRecovery =
  | {
      state: "found";
      snapshot: SandboxSnapshotInfoLike;
      marker: CheckpointMarker;
    }
  | { state: "retired" };

/** Normalize remote checkpoint recovery before each caller chooses its output. */
type CheckpointReconciliation =
  | { state: "found"; record: CheckpointRecord }
  | { state: "conflict"; existingRequestDigest: `sha256:${string}` }
  | {
      state: "undecided";
      reason: "inventory_unavailable" | "metadata_invalid";
    }
  | { state: "retired" }
  | { state: "absent" };

export function checkpointRecordFromSnapshot(
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

export function validSnapshotResult(
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

type SnapshotOperationResult = {
  snapshotId: string;
  createdAt: Date | string;
  tags?: unknown;
};

type TaggedSnapshotOperationResult = SnapshotOperationResult & {
  tags: string[];
};

type ForkOperationChildResult = {
  sandboxId?: string;
  id?: string;
  createdAt?: Date | string | null;
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

function validTaggedSnapshotOperationResult(
  value: unknown
): value is TaggedSnapshotOperationResult {
  return (
    validSnapshotOperationResult(value) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => safeString(tag) !== undefined)
  );
}

function validForkOperationChildResult(
  value: unknown
): value is ForkOperationChildResult {
  return (
    validOperationRecord(value) &&
    safeIdentifier(value.sandboxId ?? value.id) !== undefined &&
    (value.createdAt === undefined ||
      value.createdAt === null ||
      validOperationDate(value.createdAt))
  );
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
  signal?.throwIfAborted();
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

/** Read the durable record by its owner-scoped key when no request body remains. */
async function checkpointOperationLookupByKey(
  box: SandboxInstanceLike,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<SandboxWorkspaceOperationLookupLike | undefined> {
  signal?.throwIfAborted();
  return await awaitWithSignal(
    box.getSnapshotOperation?.(idempotencyKey),
    signal
  );
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

/** Confirm a fork child through its marker or the legacy fork ledger. */
async function forkOperationLookup(
  box: SandboxInstanceLike,
  marker: ForkMarker,
  signal?: AbortSignal
): Promise<SandboxWorkspaceOperationLookupLike | undefined> {
  if (marker.materialization === "snapshot") {
    return {
      outcome: "found",
      kind: "fork",
      state: "succeeded",
    };
  }
  const lookup = await awaitWithSignal(
    box.getForkOperation?.(marker.idempotencyKey, {
      count: 1,
      metadata: forkMarkerMetadata(marker.request, marker.materialization),
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

async function findCheckpointByKey(
  box: SandboxInstanceLike,
  provider: string,
  key: string,
  signal?: AbortSignal
): Promise<
  | CheckpointRecovery
  | null
  | undefined
> {
  let snapshots: SandboxSnapshotInfoLike[];
  try {
    signal?.throwIfAborted();
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
  const snapshotIds = new Set<string>();
  let found: Extract<CheckpointRecovery, { state: "found" }> | undefined;
  let unresolved = false;
  for (const snapshot of snapshots) {
    if (!validSnapshotInfo(snapshot, box.id)) return undefined;
    if (snapshotIds.has(snapshot.snapshotId)) return undefined;
    snapshotIds.add(snapshot.snapshotId);
    const marker = checkpointMarkerFromTags(snapshot.tags, key);
    if (!marker) continue;
    if (!checkpointMarkerBelongsToSource(marker, provider, box.id)) {
      return undefined;
    }
    try {
      const lookup = await checkpointOperationLookup(box, marker, signal);
      if (
        lookup?.outcome === "found" &&
        lookup.kind === "checkpoint" &&
        lookup.state === "succeeded"
      ) {
        const authoritative = snapshotFromOperationResult(snapshot, lookup);
        if (authoritative === undefined) return undefined;
        if (found !== undefined) return undefined;
        found = { state: "found", snapshot: authoritative, marker };
        continue;
      }
      unresolved = true;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  if (found !== undefined) return found;
  if (unresolved) return undefined;

  // Some storage backends retain the snapshot but omit caller tags from a
  // later inventory read. The owner-scoped operation record retains the exact
  // acknowledgement, including those tags. Bind that record to a currently
  // live snapshot id before recovering it; neither record is sufficient alone.
  let lookup: SandboxWorkspaceOperationLookupLike | undefined;
  try {
    lookup = await checkpointOperationLookupByKey(box, key, signal);
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
  if (lookup?.outcome === "not_found" && lookup.kind === "checkpoint") {
    return null;
  }
  if (
    lookup?.outcome !== "found" ||
    lookup.kind !== "checkpoint" ||
    lookup.state !== "succeeded"
  ) {
    return undefined;
  }
  if (snapshots.length === 0) return { state: "retired" };
  if (!validTaggedSnapshotOperationResult(lookup.result)) return undefined;

  const live = snapshots.filter(
    (snapshot) => snapshot.snapshotId === lookup.result?.snapshotId
  );
  if (live.length === 0) return { state: "retired" };
  if (live.length !== 1) return undefined;
  const marker = checkpointMarkerFromTags(lookup.result.tags, key);
  if (
    !marker ||
    !checkpointMarkerBelongsToSource(marker, provider, box.id)
  ) {
    return undefined;
  }
  const authoritative = snapshotFromOperationResult(live[0], lookup);
  return authoritative === undefined
    ? undefined
    : { state: "found", snapshot: authoritative, marker };
}

/** Normalize one remote checkpoint recovery attempt for every caller. */
export async function reconcileCheckpoint(
  box: SandboxInstanceLike,
  provider: string,
  request: Pick<
    WorkspaceCheckpointRequest,
    "idempotencyKey" | "requestDigest"
  >,
  signal?: AbortSignal
): Promise<CheckpointReconciliation> {
  const recovered = await findCheckpointByKey(
    box,
    provider,
    request.idempotencyKey,
    signal
  );
  if (recovered === undefined) {
    return { state: "undecided", reason: "inventory_unavailable" };
  }
  if (recovered === null) return { state: "absent" };
  if (recovered.state === "retired") return recovered;
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
  return record === undefined
    ? { state: "undecided", reason: "metadata_invalid" }
    : { state: "found", record };
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
export async function findManagedCheckpoint(
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

export async function findForkByKey(
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
 * Some Sandbox responses omit that timestamp, so the validated inventory
 * record supplies it only when the operation result does not.
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
  const createdAt = operationChild.createdAt ?? child.createdAt;
  if (!validOperationDate(createdAt)) return undefined;
  return { child, createdAt };
}

export async function findForkChildById(
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
export async function completeForkChild(
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

export async function findBlockingForks(
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

/**
 * Read a fork ledger answer for a key that left no marked resource behind.
 *
 * `absent` is the settled answer: a decided operation with no inventory marker
 * means the child was cleaned after creation, and the provider must not
 * resurrect it from the ledger. Every other state is undecided for the caller.
 */
export function lookupOutcomeFromSandbox(
  lookup: SandboxWorkspaceOperationLookupLike | undefined,
  kind: "fork"
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

export function isoDate(value: Date | string): string {
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
