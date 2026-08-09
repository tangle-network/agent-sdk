import { isDeepStrictEqual } from "node:util";
import type { SandboxInstanceLike } from "./tangle-types.js";
import {
  assertBoundedJson,
  boundedIdentifier,
  boundedString,
  isBoundedJson,
} from "./tangle-contract-safety.js";

export const EXACT_PROCESS_METADATA_KEY = "tangle.exactProcess";

export function assertExactProcessSandbox(
  box: SandboxInstanceLike,
  providerName: string,
  teamId?: string,
  requestDigest?: `sha256:${string}`,
): void {
  if (!isExactProcessSandbox(box, providerName, teamId, requestDigest)) {
    throw new Error(
      "Tangle Sandbox did not create the requested process-only runtime",
    );
  }
}

export function isExactProcessSandbox(
  box: SandboxInstanceLike,
  providerName: string,
  teamId?: string,
  requestDigest?: `sha256:${string}`,
): boolean {
  try {
    boundedIdentifier(box.id, "exact process environment id");
  } catch {
    return false;
  }
  if (box.metadata !== undefined && !isBoundedJson(box.metadata)) return false;
  if (
    !box.metadata ||
    !Object.hasOwn(box.metadata, EXACT_PROCESS_METADATA_KEY) ||
    !Object.hasOwn(box.metadata, "runtimeMode")
  ) return false;
  const marker = box.metadata[EXACT_PROCESS_METADATA_KEY];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  const record = marker as Record<string, unknown>;
  return (
    box.metadata.runtimeMode === "control" &&
    Object.hasOwn(record, "version") && record.version === 1 &&
    Object.hasOwn(record, "provider") && record.provider === providerName &&
    (teamId === undefined
      ? !Object.hasOwn(record, "teamId")
      : Object.hasOwn(record, "teamId") && record.teamId === teamId) &&
    Object.hasOwn(record, "idempotencyKey") &&
    typeof record.idempotencyKey === "string" &&
    record.idempotencyKey.length > 0 &&
    record.idempotencyKey.length <= 512 &&
    record.idempotencyKey.trim() === record.idempotencyKey &&
    Object.hasOwn(record, "requestDigest") &&
    typeof record.requestDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(record.requestDigest) &&
    (requestDigest === undefined || record.requestDigest === requestDigest)
  );
}

export function isExactProcessRequestConflict(
  box: SandboxInstanceLike,
  providerName: string,
  teamId: string | undefined,
  idempotencyKey: string,
  requestDigest: `sha256:${string}`,
): boolean {
  if (
    !box.metadata ||
    !isBoundedJson(box.metadata) ||
    box.metadata.runtimeMode !== "control"
  ) return false;
  const marker = box.metadata?.[EXACT_PROCESS_METADATA_KEY];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  const record = marker as Record<string, unknown>;
  if (record.idempotencyKey !== idempotencyKey) return false;
  return (
    record.provider !== providerName ||
    (teamId === undefined
      ? Object.hasOwn(record, "teamId")
      : record.teamId !== teamId) ||
    record.requestDigest !== requestDigest
  );
}

export function assertUnreservedMetadata(metadata: Record<string, unknown>): void {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("exact process metadata must be a JSON object");
  }
  assertBoundedJson(metadata);
  const reserved = [
    "capabilities",
    "customer_id",
    "exactProcess",
    "integrationLaunch",
    "runtimeMode",
    "teamId",
    EXACT_PROCESS_METADATA_KEY,
  ];
  if (reserved.some((name) => Object.hasOwn(metadata, name))) {
    throw new Error("exact process ownership metadata is reserved by Tangle");
  }
}

export function assertSupportedProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
): void {
  if (
    providerOptions !== undefined &&
    (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions))
  ) {
    throw new Error("Tangle exact process providerOptions must be a JSON object");
  }
  if (providerOptions && !isBoundedJson(providerOptions)) {
    throw new Error("Tangle exact process providerOptions exceed their bound");
  }
  if (providerOptions && Object.keys(providerOptions).length > 0) {
    throw new Error("Tangle exact process providerOptions are not supported");
  }
}

export function assertAbsoluteFilePath(path: string): void {
  boundedString(path, "Tangle exact process file path");
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Tangle exact process file path must be absolute");
  }
}

export function assertSignalOptions(
  value: { signal?: AbortSignal },
  label: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} options must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "signal") throw new Error(`${label} options contain unsupported field ${key}`);
  }
}

export function assertFileOptions(
  value: { mode?: number; maxBytes?: number; signal?: AbortSignal },
  label: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} options must be an object`);
  }
  const allowed = new Set(["mode", "maxBytes", "signal"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} options contain unsupported field ${key}`);
  }
}

export function metadataMatches(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) return true;
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) =>
    Object.hasOwn(actual, key) && isDeepStrictEqual(actual[key], value),
  );
}
