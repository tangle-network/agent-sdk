import { canonicalCandidateDigest } from "@tangle-network/agent-interface";
import type { CreateAgentExactProcessEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import type { TangleExactProcessOptions } from "./tangle-types.js";

export const MAX_EXACT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_LIST_RESULTS = 100_000;
/** Sandbox caps list responses at 1,000 resources. */
export const SANDBOX_LIST_PAGE_SIZE = 1_000;
export const MAX_IDENTIFIER_LENGTH = 512;
export const MAX_STRING_LENGTH = 16_384;
export const MAX_ARRAY_LENGTH = 1_024;
export const MAX_MAP_ENTRIES = 256;
export const MAX_JSON_DEPTH = 16;
export const MAX_JSON_NODES = 8_192;

const IMMUTABLE_TANGLE_IMAGE =
  /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/i;

export function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_STRING_LENGTH) {
    throw new Error(`${label} exceeds its bound`);
  }
  return value;
}

export function isBoundedJson(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number; leave?: boolean }> = [
    { value, depth: 0 },
  ];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return false;
    const current = item.value;
    if (item.leave) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === undefined) return false;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (current.length > MAX_STRING_LENGTH) return false;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (
      typeof current !== "object" ||
      item.depth >= MAX_JSON_DEPTH ||
      ancestors.has(current)
    ) return false;
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, leave: true });
    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_LENGTH) return false;
      for (const entry of current) pending.push({ value: entry, depth: item.depth + 1 });
      continue;
    }
    if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return false;
    const keys = Object.keys(current);
    if (
      keys.length > MAX_MAP_ENTRIES ||
      keys.some((key) => key.length > MAX_IDENTIFIER_LENGTH)
    ) return false;
    for (const key of keys) pending.push({ value: (current as Record<string, unknown>)[key], depth: item.depth + 1 });
  }
  return true;
}

export function assertBoundedJson(value: unknown): void {
  if (!isBoundedJson(value)) throw new Error("value exceeds its JSON bound");
}

/** Keep a late-created provider handle reachable when an abort wins the race. */
export function attachCleanupHandle(
  error: unknown,
  handle: unknown,
  cleanupError?: unknown,
): void {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  ) return;
  try {
    Object.assign(error, {
      cleanupHandle: handle,
      ...(cleanupError === undefined ? {} : { cleanupError }),
    });
  } catch {
    // A non-extensible provider error cannot carry the handle; the operation
    // still remains rejected rather than pretending cleanup completed.
  }
}

export function exactProcessRequestDigest(
  input: CreateAgentExactProcessEnvironmentInput,
  providerName: string,
  options: TangleExactProcessOptions,
): `sha256:${string}` {
  validateExactProcessCreateInput(input, providerName, options);
  assertBoundedJson(input.metadata);
  return canonicalCandidateDigest({
    provider: providerName,
    image: input.image,
    egress: input.egress,
    maxLifetimeMs: input.maxLifetimeMs,
    resources: input.resources,
    metadata: input.metadata,
    idempotencyKey: input.idempotencyKey,
    ...(options.teamId === undefined ? {} : { teamId: options.teamId }),
    ...(input.provisionTimeoutMs === undefined
      ? {}
      : { provisionTimeoutMs: input.provisionTimeoutMs }),
  });
}

export function validateExactProcessCreateInput(
  input: CreateAgentExactProcessEnvironmentInput,
  providerName: string,
  options: TangleExactProcessOptions,
): void {
  const inputKeys = new Set(Object.keys(input as object));
  for (const key of [
    "image",
    "egress",
    "maxLifetimeMs",
    "provisionTimeoutMs",
    "resources",
    "metadata",
    "idempotencyKey",
    "signal",
    "providerOptions",
  ]) inputKeys.delete(key);
  if (inputKeys.size > 0) throw new Error("exact process input contains unsupported fields");
  boundedIdentifier(providerName, "Tangle exact process provider");
  if (options.teamId !== undefined) {
    boundedIdentifier(options.teamId, "Tangle exact process team id");
  }
  boundedString(input.image, "exact process image");
  if (!input.image.trim() || !IMMUTABLE_TANGLE_IMAGE.test(input.image)) {
    throw new Error(
      "Tangle exact process image must include a sha256 manifest digest",
    );
  }
  boundedIdentifier(input.idempotencyKey, "exact process idempotencyKey");
  if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
    throw new Error("exact process metadata must be a JSON object");
  }
  assertBoundedJson(input.metadata);
  if (input.providerOptions !== undefined) {
    if (!input.providerOptions || typeof input.providerOptions !== "object" || Array.isArray(input.providerOptions)) {
      throw new Error("Tangle exact process providerOptions must be a JSON object");
    }
    assertBoundedJson(input.providerOptions);
    if (Object.keys(input.providerOptions).length > 0) {
      throw new Error("Tangle exact process providerOptions are not supported");
    }
  }
  if (!input.egress || typeof input.egress !== "object" || Array.isArray(input.egress)) {
    throw new Error("exact process egress policy is required");
  }
  if (input.egress.mode !== "blocked" && input.egress.mode !== "strict") {
    throw new Error("exact process egress mode is unsupported");
  }
  const egressKeys = new Set(Object.keys(input.egress));
  egressKeys.delete("mode");
  if (input.egress.mode === "blocked") {
    if (egressKeys.size > 0) throw new Error("blocked exact process egress has unsupported fields");
  } else {
    egressKeys.delete("allowDomains");
    if (egressKeys.size > 0) throw new Error("strict exact process egress has unsupported fields");
  }
  if (input.egress.mode === "strict") {
    if (!Array.isArray(input.egress.allowDomains)) {
      throw new Error("exact process egress allowDomains must be an array");
    }
    if (input.egress.allowDomains.length > MAX_ARRAY_LENGTH) {
      throw new Error("exact process egress allowDomains has too many entries");
    }
    if (input.egress.allowDomains.length === 0) {
      throw new Error("strict exact process egress requires at least one domain");
    }
    for (const domain of input.egress.allowDomains) {
      boundedIdentifier(domain, "exact process egress domain");
    }
  }
  if (
    !Number.isSafeInteger(input.maxLifetimeMs) ||
    input.maxLifetimeMs < 1 ||
    input.maxLifetimeMs % 1_000 !== 0
  ) {
    throw new Error("exact process maxLifetimeMs must be a positive safe integer");
  }
  if (
    input.provisionTimeoutMs !== undefined &&
    (!Number.isSafeInteger(input.provisionTimeoutMs) || input.provisionTimeoutMs < 1)
  ) {
    throw new Error("exact process provisionTimeoutMs must be a positive safe integer");
  }
  if (!input.resources || typeof input.resources !== "object" || Array.isArray(input.resources)) {
    throw new Error("exact process resources are required");
  }
  const resourceKeys = new Set(Object.keys(input.resources));
  for (const key of ["cpu", "memoryMb", "diskMb"]) resourceKeys.delete(key);
  if (resourceKeys.size > 0) throw new Error("exact process resources contain unsupported fields");
  if (!Number.isFinite(input.resources.cpu) || input.resources.cpu <= 0) {
    throw new Error("exact process CPU must be positive and finite");
  }
  for (const [name, value] of [
    ["memoryMb", input.resources.memoryMb],
    ["diskMb", input.resources.diskMb],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`exact process ${name} must be a positive safe integer`);
    }
  }
  if (input.resources.diskMb % 1_024 !== 0) {
    throw new Error("exact process diskMb must be a whole number of gibibytes");
  }
}

export async function awaitWithSignal<T>(
  operation: Promise<T> | T | undefined,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (operation === undefined) return undefined as T;
  if (!signal) return await operation;
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<T>((_, reject) => {
        listener = () => reject(new DOMException("The operation was aborted", "AbortError"));
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

/** Await an operation and clean its result if abort wins before it resolves. */
export async function awaitWithSignalAndCleanup<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal | undefined,
  cleanup: (value: T) => Promise<void> | void,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await operation();

  let aborted = false;
  let listener: (() => void) | undefined;
  const observed = Promise.resolve().then(operation).then(async (value) => {
    if (aborted) await cleanup(value);
    return value;
  });

  try {
    return await Promise.race([
      observed,
      new Promise<T>((_, reject) => {
        listener = () => {
          aborted = true;
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}
