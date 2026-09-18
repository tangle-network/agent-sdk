import { canonicalCandidateDigest } from "@tangle-network/agent-interface";
import type { CreateAgentExactProcessEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import type { TangleExactProcessOptions } from "./tangle-types.js";

export const MAX_EXACT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_LIST_RESULTS = 100_000;
/** Sandbox caps list responses at 1,000 resources. */
export const SANDBOX_LIST_PAGE_SIZE = 1_000;
export const MAX_IDENTIFIER_LENGTH = 512;
export const MAX_STRING_LENGTH = 16_384;

/**
 * MAX_STRING_LENGTH governs CONTROL-PLANE text — names, identifiers, env values, metadata — where
 * 16 KiB is already generous. It must not govern DATA. The contents of file mounts and of inline
 * profile resources are the product's cargo, and one bound for both refused a 17,894-character
 * script AFTER spawn_worker had returned a worker id, so the caller paid for the spawn and got a
 * child it could not equip (agent-sdk#340).
 *
 * Payload is measured in BYTES. `String.length` counts UTF-16 code units, so a CJK file reads a
 * third of its UTF-8 weight and an emoji half of it; every byte budget between here and the
 * sandbox counts UTF-8, so this one does too.
 *
 * 4 MiB is agent-runtime's SPAWN_RESOURCE_PATH_MAX_BYTES (0.239.0) — the largest file the runtime
 * will read off a manager's own disk for a by-path spawn resource. Those resolved bytes arrive
 * here as an inline string, so a smaller number would refuse by-path mounts the runtime had
 * already accepted, and a larger one would advertise what the runtime will not resolve.
 *
 * The transport carries it: @tangle-network/sandbox splits inline `resources.files` out of the
 * create POST and materializes them afterwards, routing any mount that no longer fits a
 * gateway-safe single-shot write — SANDBOX_PROXY_REQUEST_MAX_BYTES (1 MiB) less 8 KiB of request
 * envelope — onto chunked upload, whose session ceiling is 64 MiB. A 4 MiB mount is delivered in
 * parts, so the 1 MiB request budget on `files/write-batch` never bites.
 */
export const MAX_PAYLOAD_STRING_BYTES = 4 * 1024 * 1024;

/**
 * Inline `tools`, `agents`, `commands` and `instructions` are NOT split out: they ride the create
 * POST whole, and inline `skills` ride the one-shot profile-priming POST. Both are single request
 * bodies under the gateway's 1 MiB cap, so their TOTAL is the bound that binds, and it is the same
 * budget the sandbox client keeps for a single-shot write: 1 MiB less 8 KiB of envelope. Necessary
 * rather than sufficient — the rest of the create body shares that request and the gateway stays
 * the authority — so a resource too large for it belongs in `resources.files`.
 *
 * `commands` is bounded here as payload although agent-runtime's by-path resolver covers only
 * `tools`, `skills`, `agents` and `files`. The request that carries a command resource is the one
 * that carries the others, and leaving `commands` on the control-plane bound would refuse an 18 KiB
 * command for no transport reason. Anything the resolver gains later needs no change here.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 1024 * 1024 - 8 * 1024;

/**
 * A per-string bound multiplies: MAX_ARRAY_LENGTH mounts at MAX_PAYLOAD_STRING_BYTES is 4 GiB, and
 * `create` structuredClones and deep-freezes the whole input before the client sees it. The
 * aggregate stops at the 64 MiB this module already accepts for one exact-process file, which is
 * also the sandbox's chunked-upload session ceiling.
 */
export const MAX_TOTAL_PAYLOAD_BYTES = 64 * 1024 * 1024;

export const MAX_ARRAY_LENGTH = 1_024;
export const MAX_MAP_ENTRIES = 256;
export const MAX_JSON_DEPTH = 16;
export const MAX_JSON_NODES = 8_192;

const IMMUTABLE_TANGLE_IMAGE =
  /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/i;

export function boundedIdentifier(value: unknown, label: string): string {
  const identifier = safeIdentifier(value);
  if (identifier === undefined) throw new Error(`${label} is invalid`);
  return identifier;
}

export function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_STRING_LENGTH) {
    throw new Error(`${label} exceeds its bound`);
  }
  return value;
}

/**
 * The rule a value broke. Only the rules that COUNT something carry a limit; the rest are shape
 * rejections, where nothing is oversized and saying so misdirects the reader.
 */
export type JsonBoundRule =
  | "string"
  | "payload"
  | "inlinePayload"
  | "totalPayload"
  | "array"
  | "entries"
  | "depth"
  | "nodes"
  | "key"
  | "undefined"
  | "number"
  | "type"
  | "cycle"
  | "prototype";

export interface JsonBoundViolation {
  readonly rule: JsonBoundRule;
  /** Object keys and array indices only. A path locates the value; it never carries one. */
  readonly path: string;
  readonly observed?: number;
  readonly limit?: number;
  readonly limitName?: string;
  /** Position of the offending key among its object's own keys, for the `key` rule. */
  readonly entry?: number;
  /** A JavaScript type or constructor name — program text, not payload. */
  readonly observedType?: string;
}

/**
 * Where an AgentProfile sits inside the value being walked, as a key path from its root.
 *
 * Payload is classified by POSITION, never by a flag on the call: the same shape reached through
 * `metadata` is control-plane text and keeps MAX_STRING_LENGTH. Omit it and a value has no payload
 * at all, which is what every non-profile call site wants.
 */
export type ProfileLocation = readonly string[];

/** The value IS the profile — `assertBoundedJson(input.profile, ...)`. */
export const PROFILE_AT_ROOT: ProfileLocation = [];
/** A wrapper whose `profile` key holds it — the per-turn backend override. */
export const PROFILE_AT_PROFILE: ProfileLocation = ["profile"];
/** The mapped Sandbox create options, where it rides `backend.profile`. */
export const PROFILE_AT_BACKEND_PROFILE: ProfileLocation = ["backend", "profile"];

/** Which request carries a payload string, and therefore which bound it answers to. */
type PayloadClass = "file" | "inline";

/**
 * The walk's position relative to the profile's resource tree. A state machine rather than a path
 * match: it is index-agnostic, and it cannot be satisfied by a key that merely spells `content`
 * somewhere else in the value.
 */
type WalkScope =
  | { readonly kind: "descend"; readonly remaining: ProfileLocation }
  | { readonly kind: "profile" }
  | { readonly kind: "resources" }
  | { readonly kind: "fileList" }
  | { readonly kind: "fileMount" }
  | { readonly kind: "inlineList" }
  /** A resource ref. `bare` marks `resources.instructions`, which may be the string itself. */
  | { readonly kind: "ref"; readonly payload: PayloadClass; readonly bare: boolean }
  | { readonly kind: "payload"; readonly payload: PayloadClass };

const INLINE_RESOURCE_FIELDS = new Set(["tools", "skills", "agents", "commands"]);

function childScope(scope: WalkScope | undefined, key: string | number): WalkScope | undefined {
  if (scope === undefined) return undefined;
  switch (scope.kind) {
    case "descend": {
      if (key !== scope.remaining[0]) return undefined;
      const remaining = scope.remaining.slice(1);
      return remaining.length === 0 ? { kind: "profile" } : { kind: "descend", remaining };
    }
    case "profile":
      return key === "resources" ? { kind: "resources" } : undefined;
    case "resources":
      if (key === "files") return { kind: "fileList" };
      if (key === "instructions") return { kind: "ref", payload: "inline", bare: true };
      return typeof key === "string" && INLINE_RESOURCE_FIELDS.has(key)
        ? { kind: "inlineList" }
        : undefined;
    case "fileList":
      return typeof key === "number" ? { kind: "fileMount" } : undefined;
    case "fileMount":
      return key === "resource" ? { kind: "ref", payload: "file", bare: false } : undefined;
    case "inlineList":
      return typeof key === "number" ? { kind: "ref", payload: "inline", bare: false } : undefined;
    case "ref":
      return key === "content" ? { kind: "payload", payload: scope.payload } : undefined;
    case "payload":
      return undefined;
  }
}

function payloadClassOf(scope: WalkScope | undefined): PayloadClass | undefined {
  if (scope === undefined) return undefined;
  if (scope.kind === "payload") return scope.payload;
  return scope.kind === "ref" && scope.bare ? scope.payload : undefined;
}

function rootScope(profileAt: ProfileLocation | undefined): WalkScope | undefined {
  if (profileAt === undefined) return undefined;
  return profileAt.length === 0 ? { kind: "profile" } : { kind: "descend", remaining: profileAt };
}

/** A key or constructor name is author-chosen program text, so echoing it discloses nothing. It
 *  can still be long enough to turn a one-line reason into a dump, or carry a control character
 *  that breaks the line a journal writes it on. */
const MAX_PATH_SEGMENT_LENGTH = 48;
const MAX_PATH_LENGTH = 256;
const MAX_BOUND_MESSAGE_LENGTH = 512;
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const PLAIN_TYPE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

function boundedPathSegment(key: string): string {
  const shortened =
    key.length > MAX_PATH_SEGMENT_LENGTH ? `${key.slice(0, MAX_PATH_SEGMENT_LENGTH)}...` : key;
  return shortened.replace(/\p{C}/gu, "?");
}

function appendKeyToPath(path: string, key: string): string {
  const segment = boundedPathSegment(key);
  if (!PLAIN_KEY.test(segment)) return `${path}[${JSON.stringify(segment)}]`;
  return path === "" ? segment : `${path}.${segment}`;
}

function safeTypeName(value: unknown): string | undefined {
  return typeof value === "string" && PLAIN_TYPE_NAME.test(value) ? value : undefined;
}

/**
 * The first bound `value` breaks, in document order, or undefined when it breaks none.
 *
 * Document order matters: the walk is a LIFO stack, so children are pushed in reverse to make
 * `pop` yield the order a reader sees in the value. A reason that named whichever sibling the
 * stack happened to hold last would be a new way to mislead. Only the first violation is
 * reported — later ones may exist.
 */
export function firstJsonBoundViolation(
  value: unknown,
  profileAt?: ProfileLocation,
): JsonBoundViolation | undefined {
  const pending: Array<{
    value: unknown;
    depth: number;
    path: string;
    scope?: WalkScope;
    leave?: boolean;
  }> = [{ value, depth: 0, path: "", scope: rootScope(profileAt) }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let payloadBytes = 0;
  let inlineBytes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      return { rule: "nodes", path: item.path, observed: nodes, limit: MAX_JSON_NODES, limitName: "MAX_JSON_NODES" };
    }
    const current = item.value;
    if (item.leave) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === undefined) return { rule: "undefined", path: item.path };
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      const payload = payloadClassOf(item.scope);
      if (payload === undefined) {
        if (current.length > MAX_STRING_LENGTH) {
          return { rule: "string", path: item.path, observed: current.length, limit: MAX_STRING_LENGTH, limitName: "MAX_STRING_LENGTH" };
        }
        continue;
      }
      const bytes = Buffer.byteLength(current, "utf8");
      if (bytes > MAX_PAYLOAD_STRING_BYTES) {
        return { rule: "payload", path: item.path, observed: bytes, limit: MAX_PAYLOAD_STRING_BYTES, limitName: "MAX_PAYLOAD_STRING_BYTES" };
      }
      // Totals accumulate in document order and are checked as they cross, so an oversized value
      // is refused at the string that crossed the line rather than after the whole walk.
      if (payload === "inline") {
        inlineBytes += bytes;
        if (inlineBytes > MAX_INLINE_PAYLOAD_BYTES) {
          return { rule: "inlinePayload", path: item.path, observed: inlineBytes, limit: MAX_INLINE_PAYLOAD_BYTES, limitName: "MAX_INLINE_PAYLOAD_BYTES" };
        }
      }
      payloadBytes += bytes;
      if (payloadBytes > MAX_TOTAL_PAYLOAD_BYTES) {
        return { rule: "totalPayload", path: item.path, observed: payloadBytes, limit: MAX_TOTAL_PAYLOAD_BYTES, limitName: "MAX_TOTAL_PAYLOAD_BYTES" };
      }
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return { rule: "number", path: item.path };
      continue;
    }
    if (typeof current !== "object") {
      return { rule: "type", path: item.path, observedType: safeTypeName(typeof current) };
    }
    if (item.depth >= MAX_JSON_DEPTH) {
      return { rule: "depth", path: item.path, observed: item.depth, limit: MAX_JSON_DEPTH, limitName: "MAX_JSON_DEPTH" };
    }
    if (ancestors.has(current)) return { rule: "cycle", path: item.path };
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, path: item.path, scope: item.scope, leave: true });
    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_LENGTH) {
        return { rule: "array", path: item.path, observed: current.length, limit: MAX_ARRAY_LENGTH, limitName: "MAX_ARRAY_LENGTH" };
      }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current[index],
          depth: item.depth + 1,
          path: `${item.path}[${index}]`,
          scope: childScope(item.scope, index),
        });
      }
      continue;
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      return {
        rule: "prototype",
        path: item.path,
        observedType: safeTypeName((prototype as { constructor?: { name?: unknown } } | null)?.constructor?.name),
      };
    }
    const keys = Object.keys(current);
    if (keys.length > MAX_MAP_ENTRIES) {
      return { rule: "entries", path: item.path, observed: keys.length, limit: MAX_MAP_ENTRIES, limitName: "MAX_MAP_ENTRIES" };
    }
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key.length > MAX_IDENTIFIER_LENGTH) {
        // The over-long key IS the value that broke this bound, so it is located by ordinal
        // rather than echoed. Every other rule names a path whose segments are bounded keys.
        return { rule: "key", path: item.path, entry: index, observed: key.length, limit: MAX_IDENTIFIER_LENGTH, limitName: "MAX_IDENTIFIER_LENGTH" };
      }
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      pending.push({
        value: (current as Record<string, unknown>)[keys[index]],
        depth: item.depth + 1,
        path: appendKeyToPath(item.path, keys[index]),
        scope: childScope(item.scope, keys[index]),
      });
    }
  }
  return undefined;
}

export function isBoundedJson(value: unknown, profileAt?: ProfileLocation): boolean {
  return firstJsonBoundViolation(value, profileAt) === undefined;
}

/**
 * One line naming the rule, where it broke, what was measured, and the limit — and never the
 * value. Profile and metadata strings carry prompt text, mounted briefs, and through `env`,
 * `mcp.*.env` and `headers` material adjacent to secrets, so no prefix, excerpt, or
 * length-preserving echo of a value belongs in a reason a journal keeps.
 */
export function describeJsonBoundViolation(violation: JsonBoundViolation): string {
  const at =
    violation.path === ""
      ? "(root)"
      : violation.path.length > MAX_PATH_LENGTH
        // The leaf is what a reader looks for, so a path too long to keep loses its head.
        ? `...${violation.path.slice(violation.path.length - MAX_PATH_LENGTH)}`
        : violation.path;
  const limit = `limit ${violation.limit} (${violation.limitName})`;
  switch (violation.rule) {
    case "string":
      return `string at ${at} is ${violation.observed} characters, ${limit}`;
    case "payload":
      return `payload at ${at} is ${violation.observed} bytes, ${limit}; split it or fetch it from inside the environment`;
    case "inlinePayload":
      return `inline profile resources total ${violation.observed} bytes at ${at}, ${limit}; they ride one create request, so move the large ones to resources.files`;
    case "totalPayload":
      return `profile payload totals ${violation.observed} bytes at ${at}, ${limit}; split it across turns`;
    case "array":
      return `array at ${at} has ${violation.observed} entries, ${limit}`;
    case "entries":
      return `object at ${at} has ${violation.observed} entries, ${limit}`;
    case "depth":
      return `object at ${at} is at depth ${violation.observed}, ${limit}`;
    case "nodes":
      return `the walk reached ${violation.observed} nodes at ${at}, ${limit}`;
    case "key":
      return `key ${violation.entry} of the object at ${at} is ${violation.observed} characters, ${limit}`;
    case "undefined":
      return `undefined at ${at} has no JSON form`;
    case "number":
      return `number at ${at} is not finite`;
    case "cycle":
      return `cycle at ${at}: the value refers back to one of its own ancestors`;
    case "prototype":
      return violation.observedType === undefined
        ? `object at ${at} has a prototype that is not Object.prototype`
        : `object at ${at} has a ${violation.observedType} prototype, not a plain object prototype`;
    case "type":
      return violation.observedType === undefined
        ? `value at ${at} has a type with no JSON form`
        : `${violation.observedType} at ${at} has no JSON form`;
  }
}

/**
 * `label` names WHICH field was rejected. agent-runtime's `errMessage` flattens a cause chain to
 * `name: message`, so without it a run record cannot say whether the rejected value was the
 * profile, the metadata, or a providerOptions map — which is how three children settled on five
 * words that identified nothing.
 */
/**
 * A value refused by a JSON bound, as an error a consumer can classify without reading text.
 *
 * Every refusal in this package was a plain `Error` with a message, and the runtime that
 * supervises these environments classifies a failed retained execution from the error's
 * STRUCTURE — class name, `code`, status — never its message, because this package's messages
 * are not a contract. So a bound refusal reached its journal under the one name reserved for an
 * execution nobody can observe, telling the operator to reconcile before retrying when nothing
 * had run and nothing needed reconciling (agent-runtime#1204, exhibit 6).
 *
 * `name` and `code` are stable; `message` stays the operator-facing line and may change. The
 * violation is carried whole so a reader can act on the rule and the path without parsing.
 */
export class JsonBoundError extends Error {
  readonly code = "JSON_BOUND_VIOLATION" as const;
  readonly label: string;
  readonly violation: JsonBoundViolation;

  constructor(label: string, violation: JsonBoundViolation, message: string) {
    super(message);
    this.name = "JsonBoundError";
    this.label = label;
    this.violation = violation;
  }
}

export function assertBoundedJson(value: unknown, label = "value", profileAt?: ProfileLocation): void {
  const violation = firstJsonBoundViolation(value, profileAt);
  if (violation === undefined) return;
  // A rule with no limit counted nothing: a Date, a cycle, a NaN and an absent value are not
  // oversized, and "exceeds" sends the reader after a size problem that does not exist.
  const verdict = violation.limit === undefined ? "violates" : "exceeds";
  const message = `${label} ${verdict} its JSON bound: ${describeJsonBoundViolation(violation)}`;
  throw new JsonBoundError(
    label,
    violation,
    message.length > MAX_BOUND_MESSAGE_LENGTH
      ? `${message.slice(0, MAX_BOUND_MESSAGE_LENGTH - 3)}...`
      : message,
  );
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
  assertBoundedJson(input.metadata, "exact process metadata");
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
  assertBoundedJson(input.metadata, "exact process metadata");
  if (input.providerOptions !== undefined) {
    if (!input.providerOptions || typeof input.providerOptions !== "object" || Array.isArray(input.providerOptions)) {
      throw new Error("Tangle exact process providerOptions must be a JSON object");
    }
    assertBoundedJson(input.providerOptions, "exact process providerOptions");
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

export function cloneJson<T>(value: T, label?: string): T {
  assertBoundedJson(value, label);
  return structuredClone(value);
}

export function safeIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  )
    return undefined;
  return value;
}

export function safeString(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_LENGTH
  )
    return undefined;
  return value;
}
