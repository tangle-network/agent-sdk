import {
  WorkspaceCheckpointRequestSchema,
  WorkspaceForkRequestSchema,
  sha256Bytes,
} from "@tangle-network/agent-interface";
import type {
  WorkspaceCheckpointRequest,
  WorkspaceForkRequest,
} from "@tangle-network/agent-interface";
import {
  assertBoundedJson,
  cloneJson,
  safeString,
} from "./tangle-contract-safety.js";

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

export interface CheckpointMarker {
  version: 1;
  kind: "checkpoint";
  idempotencyKey: string;
  requestDigest: `sha256:${string}`;
  request: WorkspaceCheckpointRequest;
  /** True only for markers written by the pre-128-byte-tag release. */
  legacy?: boolean;
}

export interface ForkMarker {
  version: 1;
  kind: "fork";
  idempotencyKey: string;
  requestDigest: `sha256:${string}`;
  request: WorkspaceForkRequest;
  /** New markers identify children created from the durable checkpoint. */
  materialization?: "snapshot";
}

export function checkpointMarkerTags(request: WorkspaceCheckpointRequest): string[] {
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
  const base = `${MARKER_PREFIX}-checkpoint`;
  const chunks = splitIntoChunks(encoded, MARKER_CHUNK_SIZE);
  if (chunks.length > MAX_MARKER_CHUNKS) {
    throw new Error("workspace marker exceeds the recovery bound");
  }
  return [
    `${base}-key-${markerKeyDigest(request.idempotencyKey).replace(":", "-")}`,
    `${base}-digest-${request.requestDigest.replace(":", "-")}`,
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

/** Rebuild the exact tags used by the release before the current safe format. */
export function legacyCheckpointMarkerTags(
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

export function forkMarkerMetadata(
  request: WorkspaceForkRequest,
  materialization: "snapshot" | undefined = "snapshot"
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
    ...(materialization === "snapshot" ? { materialization } : {}),
  };
  assertBoundedJson(marker);
  return {
    ...(request.metadata === undefined ? {} : cloneJson(request.metadata)),
    [FORK_METADATA_KEY]: marker,
  };
}

export function markerBelongsToSource(
  marker: ForkMarker,
  provider: string,
  sourceEnvironmentId: string
): boolean {
  return (
    marker.request.checkpoint.provider === provider &&
    marker.request.checkpoint.source.environmentId === sourceEnvironmentId
  );
}

export function checkpointMarkerBelongsToSource(
  marker: CheckpointMarker,
  provider: string,
  sourceEnvironmentId: string
): boolean {
  return (
    marker.request.source.provider === provider &&
    marker.request.source.environmentId === sourceEnvironmentId
  );
}

export function checkpointMarkerFromTags(
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

export function forkMarkerFromMetadata(
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
  if (
    parsed.materialization !== undefined &&
    parsed.materialization !== "snapshot"
  ) {
    return undefined;
  }
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
    ...(parsed.materialization === "snapshot"
      ? { materialization: "snapshot" as const }
      : {}),
  };
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
