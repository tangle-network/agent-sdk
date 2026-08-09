import type {
  CheckpointRef,
  CheckpointRequest,
  ExecRequest,
  ForkRequest,
} from "@tangle-network/agent-interface/environment-provider";
import {
  assertBoundedJson,
  boundedIdentifier,
  boundedString,
  MAX_MAP_ENTRIES,
} from "./tangle-contract-safety.js";

export function assertOptionKeys(
  value: object | undefined,
  allowed: readonly string[],
  label: string,
): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} options must be an object`);
  }
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new Error(`${label} options contain unsupported field ${key}`);
  }
}

export function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  assertBoundedJson(value);
  if (Object.keys(value).length > MAX_MAP_ENTRIES) {
    throw new Error(`${label} has too many entries`);
  }
}

export function assertExecOptions(options: ExecRequest | undefined): void {
  assertOptionKeys(options, ["cwd", "env", "timeoutMs", "signal"], "Tangle exec");
  if (options?.cwd !== undefined) boundedString(options.cwd, "Tangle exec cwd");
  if (options?.env !== undefined) {
    assertRecord(options.env, "Tangle exec environment");
    for (const [key, value] of Object.entries(options.env)) {
      boundedIdentifier(key, "Tangle exec environment key");
      boundedString(value, "Tangle exec environment value");
    }
  }
  if (
    options?.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    throw new Error("Tangle exec timeoutMs must be a positive safe integer");
  }
}

export function assertCheckpointOptions(
  options: (CheckpointRequest & { signal?: AbortSignal }) | undefined,
): void {
  assertOptionKeys(options, ["name", "metadata", "signal"], "Tangle checkpoint");
  if (options?.name !== undefined) boundedString(options.name, "Tangle checkpoint name");
  if (options?.metadata !== undefined) assertRecord(options.metadata, "Tangle checkpoint metadata");
}

export function assertCheckpointRef(checkpoint: CheckpointRef): void {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error("Tangle fork checkpoint must be an object");
  }
  assertOptionKeys(checkpoint, ["id", "provider", "metadata"], "Tangle fork checkpoint");
  boundedIdentifier(checkpoint.id, "Tangle checkpoint id");
  if (checkpoint.provider !== undefined) boundedIdentifier(checkpoint.provider, "Tangle checkpoint provider");
  if (checkpoint.metadata !== undefined) assertRecord(checkpoint.metadata, "Tangle checkpoint metadata");
}

export function assertForkOptions(
  options: (ForkRequest & { signal?: AbortSignal }) | undefined,
): void {
  assertOptionKeys(options, ["name", "metadata", "signal"], "Tangle fork");
  if (options?.name !== undefined) boundedString(options.name, "Tangle fork name");
  if (options?.metadata !== undefined) assertRecord(options.metadata, "Tangle fork metadata");
}
