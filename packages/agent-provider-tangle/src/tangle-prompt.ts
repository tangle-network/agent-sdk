import { randomUUID } from "node:crypto";
import { normalizeRuntimeBackendConfig } from "@tangle-network/sandbox";
import { projectAgentTerminalRecord } from "@tangle-network/sandbox/runtime";
import {
  assertCliAuthReferenceSupported,
  cliAuthReferenceSchema,
} from "@tangle-network/sandbox/auth";
import type {
  BackendConfig,
  PromptOptions,
  PromptResult,
} from "@tangle-network/sandbox";
import type {
  AgentTurnInput,
  AgentTurnResult,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentExactRunControlRef,
  InputPart,
} from "@tangle-network/agent-interface";
import {
  agentProfileSchema,
  canonicalAgentProfileDigest, canonicalCandidateDigest,
  boundedEventContentRecordSchema,
  AgentExactRunControlRefSchema,
  AgentTurnInputSchema,
  ContextTransferReceiptSchema,
  ProxySecretReceiptSchema, deepFreeze, isProxySecretScopeAttenuation,
  proxySecretPresentationsEqual, type ProxySecretReceipt, type ProxySecretBinding,
  contextTransferResultMatchesRequest,
} from "@tangle-network/agent-interface";
import { tokenUsageFromData } from "./tangle-result-values.js";
import { TangleCredentialCapacityError } from "./model-credential-capacity.js";
import {
  assertBoundedJson,
  awaitWithSignal,
  boundedString,
  PROFILE_AT_PROFILE,
} from "./tangle-contract-safety.js";
import { profileCredentialSource } from "./model-credential-source.js";
import { tangleRuntimeAttachments } from "./tangle-runtime-attachments.js";
import { sessionPromptSessionId } from "./tangle-session-control.js";
import type { SandboxInstanceLike } from "./tangle-types.js";

export function promptFromTurnInput(input: AgentTurnInput): string | InputPart[] {
  AgentTurnInputSchema.parse(input);
  if (input.parts) return input.parts;
  return input.prompt ?? "";
}

export function executionIdFromTurnInput(input: AgentTurnInput): string | undefined {
  return input.executionId ?? input.controlRef?.executionId;
}

export function promptOptionsFromTurnInput(
  input: AgentTurnInput,
  target: {
    provider: string;
    environmentId: string;
    sessionId?: string;
  },
): PromptOptions {
  if (input.contextTransfer !== undefined) {
    throw new Error(
      "Tangle provider does not yet support portable context transfer",
    );
  }
  if (input.nativeContinuation !== undefined) {
    throw new Error(
      "Tangle provider does not yet support verified native continuation",
    );
  }

  AgentTurnInputSchema.parse(input);
  const controlRef = input.controlRef
    ? AgentExactRunControlRefSchema.parse(input.controlRef)
    : undefined;
  if (controlRef) {
    if (
      controlRef.provider !== target.provider ||
      controlRef.environmentId !== target.environmentId ||
      (target.sessionId !== undefined &&
        controlRef.sessionId !== target.sessionId)
    ) {
      throw new Error("Tangle control reference does not match this target");
    }
    if (controlRef.sessionId === undefined || controlRef.executionId === undefined) {
      throw new Error(
        "Tangle control reference requires exact sessionId and executionId",
      );
    }
    if (
      input.sessionId !== undefined &&
      input.sessionId !== controlRef.sessionId
    ) {
      throw new Error("Tangle sessionId conflicts with the control reference");
    }
    if (
      input.executionId !== undefined &&
      input.executionId !== controlRef.executionId
    ) {
      throw new Error("Tangle executionId conflicts with the control reference");
    }
  }

  const backend = turnBackendOptions(input);

  const sessionId = input.sessionId ?? controlRef?.sessionId;
  const executionId = input.executionId ?? controlRef?.executionId;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.nativeResume === undefined ? {} : { nativeResume: input.nativeResume }),
    ...(backend === undefined ? {} : { backend }),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(executionId ? { executionId } : {}),
    ...(controlRef ? { runControlRef: controlRef } : {}),
    ...(input.lastEventId ? { lastEventId: input.lastEventId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.detach !== undefined ? { detach: input.detach } : {}),
  };
}

export function proxySecretReceiptFromSandbox(box: SandboxInstanceLike): ProxySecretReceipt | undefined {
  if (box.proxySecretReceipt === undefined) return undefined;
  const receipt = ProxySecretReceiptSchema.parse(box.proxySecretReceipt);
  if (receipt.sandboxId !== box.id) throw new Error("Tangle proxy receipt names another sandbox");
  return deepFreeze(receipt);
}

function requireProxyReceipt(receipt: ProxySecretReceipt | undefined, bindings: readonly ProxySecretBinding[], installed: boolean): ProxySecretReceipt {
  if (!receipt || receipt.status === "revoked" || (installed && receipt.status !== "installed") ||
      receipt.bindings.some(({ grant }) => Date.parse(grant.expiresAt) <= Date.now()) ||
      bindings.some((binding) => !receipt.bindings.some(({ envName, secretRef, grant }) =>
        envName === binding.envName && canonicalCandidateDigest(secretRef) === canonicalCandidateDigest(binding.secretRef) &&
        isProxySecretScopeAttenuation(binding, grant.scope) && proxySecretPresentationsEqual(binding.presentation, grant.presentation) &&
        grant.placeholderFormat === (binding.placeholderFormat ?? "opaque") &&
        (binding.ttlSeconds === undefined || Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) <= binding.ttlSeconds * 1000)))) {
    throw new Error("Tangle canonical launch requires a current matching installed proxy receipt");
  }
  return receipt;
}

function containsProxyReceipt(full: ProxySecretReceipt, subset: ProxySecretReceipt): boolean {
  return full.sandboxId === subset.sandboxId && full.generation === subset.generation &&
    subset.bindings.every((binding) => full.bindings.some((member) => canonicalCandidateDigest(member) === canonicalCandidateDigest(binding)));
}

/** Prepare one exact launch; legacy and cursor replay retain their existing path. */
export async function preparePromptOptions(
  box: SandboxInstanceLike,
  options: PromptOptions,
  provider: string,
  bindings?: readonly ProxySecretBinding[],
): Promise<PromptOptions> {
  if (options.lastEventId !== undefined) return options;
  const selected = bindings ?? [];
  const canonical = selected.length > 0;
  const isolated = options.backend?.runtimeSecrets !== undefined || options.backend?.metadata?.profileSecretIsolation === true;
  const native = canonical ? options.backend?.model?.cliAuth : undefined;
  if (!canonical && !isolated) return options;
  if (canonical && !box.refresh) throw new Error("Tangle canonical launch requires current sandbox information");
  if (canonical) await awaitWithSignal(box.refresh?.(options.signal), options.signal);
  const before = canonical ? requireProxyReceipt(proxySecretReceiptFromSandbox(box), selected, false) : undefined;
  if (isolated || native !== undefined) {
    if (!box.createSession || (isolated ? !box.prepareSecretProfileRevision : !box.preparePublicProfileRevision))
      throw new Error("Tangle profile preparation is unsupported by this Sandbox client");
    options.signal?.throwIfAborted();
    const sessionId = options.sessionId ?? sessionPromptSessionId(provider, box.id, options.turnId ?? options.executionId) ?? randomUUID();
    const backend = isolated ? { ...options.backend, metadata: { ...options.backend?.metadata, profileSecretIsolation: true as const } } : options.backend ?? {};
    const { runtimeSecrets: _turnOnly, ...persisted } = backend;
    const created = await awaitWithSignal(box.createSession({ sessionId, retention: "workspace", backend: persisted }), options.signal);
    if (created.session.id !== sessionId || created.info.id !== sessionId) throw new Error("Tangle profile preparation changed its exact session identity");
    const args = { sessionId, backend, ...(options.model === undefined ? {} : { model: options.model }) };
    if (isolated) {
      const prepared = await awaitWithSignal(box.prepareSecretProfileRevision!(args), options.signal);
      options = { ...options, sessionId, backend, expectedPublicProfileRequestDigest: prepared.expectedPublicProfileRequestDigest, expectedSecretProfileReceipt: prepared.expectedSecretProfileReceipt };
      if (canonical) validatePrepared(prepared.proxySecretReceipt);
    } else {
      const prepared = await awaitWithSignal(box.preparePublicProfileRevision!(args), options.signal);
      options = { ...options, sessionId, backend, expectedPublicProfileRequestDigest: prepared.expectedPublicProfileRequestDigest, expectedPublicProfileRevision: prepared.expectedPublicProfileRevision };
      validatePrepared(prepared.proxySecretReceipt);
    }
  }
  if (before !== undefined) {
    // First join any pre-ACK read; the second refresh necessarily begins after that ACK.
    await awaitWithSignal(box.refresh?.(options.signal), options.signal);
    await awaitWithSignal(box.refresh?.(options.signal), options.signal);
    const current = requireProxyReceipt(proxySecretReceiptFromSandbox(box), selected, true);
    if (!containsProxyReceipt(current, before) || current.bindings.length !== before.bindings.length)
      throw new Error("Tangle proxy custody changed during profile preparation");
  }
  options.signal?.throwIfAborted();
  return options;

  function validatePrepared(raw: ProxySecretReceipt | undefined): void {
    if (raw === undefined && native === undefined) return;
    const subset = ProxySecretReceiptSchema.parse(raw);
    const expectedGroup = before?.bindings.filter(({ secretRef }) => secretRef.key === native?.secretEnv);
    if (!before || subset.status !== "installed" || !subset.bindings.length || !containsProxyReceipt(before, subset) ||
        (native !== undefined && (subset.bindings.length !== expectedGroup?.length ||
          subset.bindings.some(({ secretRef }) => secretRef.key !== native.secretEnv))))
      throw new Error("Tangle native HOME acknowledgement does not match current custody");
  }
}

const SANDBOX_BACKEND_FIELD_LIST = [
  "runtimeAttachments", "runtimeSecrets", "type", "profile", "model", "server", "interactions", "metadata",
] as const;

const SANDBOX_BACKEND_MODEL_FIELD_LIST = [
  "provider", "model", "apiKey", "baseUrl", "maxThinkingTokens", "mode",
  "apiKeyEnv", "cliAuth", "authMode", "authFiles", "routing",
] as const;

const SANDBOX_BACKEND_MODEL_FIELDS = new Set<string>(SANDBOX_BACKEND_MODEL_FIELD_LIST);
const SANDBOX_BACKEND_FIELDS = new Set<string>([...SANDBOX_BACKEND_FIELD_LIST,
  ...SANDBOX_BACKEND_MODEL_FIELD_LIST.map((field) => field === "model" ? "modelId" : field)]);

type Exhaustive<T extends never> = T;

type SandboxBackendModel = NonNullable<BackendConfig["model"]>;

const SANDBOX_AUTH_FILE_FIELD_LIST = ["path", "content", "mode"] as const;

type SandboxAuthFile = NonNullable<SandboxBackendModel["authFiles"]>[number];

type FieldDifference<T, Fields extends readonly PropertyKey[]> =
  | Exclude<keyof T, Fields[number]>
  | Exclude<Fields[number], keyof T>;

// Each SDK field set must match its runtime allowlist in both directions.
export type SandboxBackendFieldCoverage = Exhaustive<
  | FieldDifference<Omit<BackendConfig, Exclude<(typeof SANDBOX_BACKEND_MODEL_FIELD_LIST)[number], "model"> | "modelId">, typeof SANDBOX_BACKEND_FIELD_LIST>
  | FieldDifference<SandboxBackendModel, typeof SANDBOX_BACKEND_MODEL_FIELD_LIST>
  | FieldDifference<SandboxAuthFile, typeof SANDBOX_AUTH_FILE_FIELD_LIST>
>;

type SandboxPromptBackend = NonNullable<PromptOptions["backend"]>;

/** Validate the exact per-turn backend projection. */
export function backendFromTurnProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
): SandboxPromptBackend | undefined {
  if (providerOptions === undefined) return undefined;
  assertDeclaredFields(
    providerOptions,
    new Set(["backend"]),
    "Tangle prompt providerOptions",
  );
  if (!Object.hasOwn(providerOptions, "backend")) return undefined;
  return sandboxPromptBackend(providerOptions.backend);
}

export function normalizeTangleBackend(value: unknown, allowRouting = false): BackendConfig | undefined {
  if (value === undefined) return undefined;
  const source = plainRecord(value, "Tangle backend options"), canonical = { ...source };
  assertDeclaredFields(source, SANDBOX_BACKEND_FIELDS, "Tangle backend options");
  const model = source.model === undefined ? {} : { ...plainRecord(source.model, "Tangle backend model") };
  assertDeclaredFields(model, SANDBOX_BACKEND_MODEL_FIELDS, "Tangle backend model");
  for (const field of SANDBOX_BACKEND_MODEL_FIELD_LIST) {
    const alias = field === "model" ? "modelId" : field, selected = source[alias];
    if (selected === undefined) continue;
    if (model[field] !== undefined && canonicalCandidateDigest(model[field]) !== canonicalCandidateDigest(selected))
      throw new Error(`Tangle backend ${alias} conflicts with model.${field}`);
    model[field] = selected;
    delete canonical[alias];
  }
  if (source.model !== undefined || Object.keys(model).length) canonical.model = model;
  if (canonical.server !== undefined) plainRecord(canonical.server, "Tangle backend server");
  return normalizeRuntimeBackendConfig(canonical, { allowRuntimeSecrets: true, allowRouting });
}

function sandboxPromptBackend(value: unknown): SandboxPromptBackend {
  const present = normalizeTangleBackend(value) ?? {};
  const backend = {
    ...(present.type === undefined
      ? {}
      : { type: boundedString(present.type, "Tangle prompt backend type") }),
    // The profile schema owns payload and security policy.
    ...(present.profile === undefined
      ? {}
      : { profile: agentProfileSchema.parse(present.profile) }),
    ...(present.model === undefined
      ? {}
      : { model: sandboxPromptBackendModel(present.model) }),
    ...(present.server === undefined
      ? {}
      : { server: sandboxPromptBackendServer(present.server) }),
    ...(present.interactions === undefined
      ? {}
      : { interactions: sandboxPromptInteractions(present.interactions) }),
    ...(present.metadata === undefined
      ? {}
      : { metadata: sandboxPromptBackendMetadata(present.metadata) }),
  };
  if (backend.profile?.model?.metadata?.credentialSource === "managed" &&
    (backend.model?.cliAuth !== undefined || backend.model?.authFiles !== undefined || backend.model?.authMode === "oauth")) {
    throw new Error("Tangle explicit managed profile cannot receive native subscription credentials");
  }
  if (backend.profile !== undefined) profileCredentialSource(backend.profile);
  if (backend.model?.cliAuth !== undefined) {
    if (backend.type === undefined) {
      throw new Error("Tangle prompt cliAuth requires the selected backend type");
    }
    if (backend.profile !== undefined && profileCredentialSource(backend.profile) !== "subscription") {
      throw new Error("Tangle prompt native credentials require subscription intent in the exact profile");
    }
    if (backend.profile?.harness !== undefined && backend.profile.harness !== backend.type) {
      throw new Error("Tangle prompt cliAuth must use the exact profile harness");
    }
    assertCliAuthReferenceSupported(backend.type, backend.model as SandboxBackendModel);
  }
  if (present.runtimeSecrets !== undefined) {
    Object.assign(backend, { runtimeSecrets: present.runtimeSecrets });
  }
  if (present.runtimeAttachments !== undefined) {
    Object.assign(backend, {
      runtimeAttachments: tangleRuntimeAttachments(present.runtimeAttachments, backend.profile),
    });
  }
  assertBoundedJson(backend, "Tangle prompt backend", PROFILE_AT_PROFILE);
  return backend as SandboxPromptBackend;
}

function sandboxPromptBackendModel(value: unknown): Record<string, unknown> {
  const present = plainRecord(value, "Tangle prompt backend model options");
  assertDeclaredFields(
    present,
    SANDBOX_BACKEND_MODEL_FIELDS,
    "Tangle prompt backend model options",
  );
  const model: Record<string, unknown> = {};
  for (const field of ["provider", "model", "apiKey", "baseUrl", "apiKeyEnv"] as const) {
    if (present[field] === undefined) continue;
    if (typeof present[field] !== "string" || present[field] === "") {
      throw new Error(`Tangle prompt backend model ${field} must be a non-empty string`);
    }
    model[field] = boundedString(present[field], `Tangle prompt backend model ${field}`);
  }
  if (present.maxThinkingTokens !== undefined) {
    if (
      !Number.isSafeInteger(present.maxThinkingTokens) ||
      (present.maxThinkingTokens as number) < 0
    ) {
      throw new Error(
        "Tangle prompt backend model maxThinkingTokens must be a non-negative integer",
      );
    }
    model.maxThinkingTokens = present.maxThinkingTokens;
  }
  if (present.mode !== undefined) {
    if (present.mode !== "api" && present.mode !== "cli") {
      throw new Error('Tangle prompt backend model mode must be "api" or "cli"');
    }
    model.mode = present.mode;
  }
  if (present.authMode !== undefined) {
    if (present.authMode !== "api-key" && present.authMode !== "oauth") {
      throw new Error(
        'Tangle prompt backend model authMode must be "api-key" or "oauth"',
      );
    }
    model.authMode = present.authMode;
  }
  if (present.authFiles !== undefined) {
    model.authFiles = sandboxPromptAuthFiles(present.authFiles);
  }
  if (present.cliAuth !== undefined) {
    const parsed = cliAuthReferenceSchema.safeParse(present.cliAuth);
    if (!parsed.success) throw new Error("Tangle prompt cliAuth must be a valid stored-secret reference");
    model.cliAuth = parsed.data;
  }
  return model;
}

function sandboxPromptBackendServer(value: unknown): Record<string, unknown> {
  const present = plainRecord(value, "Tangle prompt backend server options");
  assertDeclaredFields(
    present,
    new Set(["port", "hostname"]),
    "Tangle prompt backend server options",
  );
  const server: Record<string, unknown> = {};
  if (present.port !== undefined) {
    if (
      !Number.isSafeInteger(present.port) ||
      (present.port as number) < 1 ||
      (present.port as number) > 65_535
    ) {
      throw new Error("Tangle prompt backend server port must be a TCP port number");
    }
    server.port = present.port;
  }
  if (present.hostname !== undefined) {
    if (typeof present.hostname !== "string" || present.hostname === "") {
      throw new Error("Tangle prompt backend server hostname must be a non-empty string");
    }
    server.hostname = boundedString(present.hostname, "Tangle prompt backend server hostname");
  }
  return server;
}

function sandboxPromptInteractions(value: unknown): Record<string, boolean> {
  const present = plainRecord(value, "Tangle prompt backend interactions");
  assertDeclaredFields(
    present,
    new Set(["permission", "question", "plan"]),
    "Tangle prompt backend interactions",
  );
  const interactions: Record<string, boolean> = {};
  for (const kind of ["permission", "question", "plan"] as const) {
    if (present[kind] === undefined) continue;
    if (typeof present[kind] !== "boolean") {
      throw new Error(`Tangle prompt backend interaction ${kind} must be a boolean`);
    }
    interactions[kind] = present[kind];
  }
  return interactions;
}

const MAX_TRACE_ATTRIBUTES = 32;
const MAX_TRACE_ATTRIBUTE_KEY_LENGTH = 128;
const MAX_TRACE_ATTRIBUTE_VALUE_LENGTH = 1_024;

function sandboxPromptBackendMetadata(value: unknown): Record<string, unknown> {
  const present = plainRecord(value, "Tangle prompt backend metadata");
  assertDeclaredFields(
    present,
    new Set(["containerType", "traceAttributes"]),
    "Tangle prompt backend metadata",
  );
  const metadata: Record<string, unknown> = {};
  if (present.containerType !== undefined) {
    if (typeof present.containerType !== "string" || present.containerType === "") {
      throw new Error("Tangle prompt backend metadata containerType must be a non-empty string");
    }
    metadata.containerType = boundedString(
      present.containerType,
      "Tangle prompt backend metadata containerType",
    );
  }
  if (present.traceAttributes !== undefined) {
    const attributes = plainRecord(
      present.traceAttributes,
      "Tangle prompt backend metadata traceAttributes",
    );
    const entries = Object.entries(attributes);
    if (entries.length > MAX_TRACE_ATTRIBUTES) {
      throw new Error(
        `Tangle prompt backend metadata traceAttributes exceeds ${MAX_TRACE_ATTRIBUTES} entries`,
      );
    }
    for (const [key, attribute] of entries) {
      if (key.length > MAX_TRACE_ATTRIBUTE_KEY_LENGTH) {
        throw new Error("Tangle prompt backend metadata traceAttributes key exceeds its bound");
      }
      if (
        typeof attribute !== "string" ||
        attribute.length > MAX_TRACE_ATTRIBUTE_VALUE_LENGTH
      ) {
        throw new Error(
          "Tangle prompt backend metadata traceAttributes value must be a bounded string",
        );
      }
    }
    metadata.traceAttributes = { ...attributes };
  }
  return metadata;
}

function sandboxPromptAuthFiles(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error("Tangle prompt backend authFiles must be an array");
  }
  return value.map((entry) => {
    const present = plainRecord(entry, "Tangle prompt backend auth file");
    assertDeclaredFields(
      present,
      new Set<string>(SANDBOX_AUTH_FILE_FIELD_LIST),
      "Tangle prompt backend auth file fields",
    );
    if (typeof present.path !== "string" || present.path.length === 0) {
      throw new Error("Tangle prompt backend auth file requires a path");
    }
    if (typeof present.content !== "string") {
      throw new Error("Tangle prompt backend auth file requires string content");
    }
    if (present.mode !== undefined && !Number.isSafeInteger(present.mode)) {
      throw new Error("Tangle prompt backend auth file mode must be an integer");
    }
    return {
      path: boundedString(present.path, "Tangle prompt backend auth file path"),
      content: present.content,
      ...(present.mode === undefined ? {} : { mode: present.mode }),
    };
  });
}

function assertDeclaredFields(
  record: Record<string, unknown>,
  declared: ReadonlySet<string>,
  label: string,
): void {
  const unsupported = Object.keys(record).filter((key) => !declared.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} are not supported: ${unsupported.sort().join(", ")}`);
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Request identity excludes bearer bytes; auth files contribute only paths and modes. */
export function backendRequestIdentity(
  backend: SandboxPromptBackend | undefined,
): Record<string, unknown> | undefined {
  if (backend === undefined) return undefined;
  const normalized = (normalizeRuntimeBackendConfig(backend, { allowRuntimeSecrets: true }) ?? {}) as SandboxPromptBackend;
  // Admission omits turn credentials; the executor independently binds their values.
  const { runtimeSecrets: _runtimeSecrets, ...identity } = normalized;
  const model = normalized.model;
  if (model === undefined) return identity;
  const { apiKey: _apiKey, authFiles, ...rest } = model;
  return {
    ...identity,
    model: {
      ...rest,
      ...(authFiles === undefined
        ? {}
        : {
            authFiles: authFiles.map((file) => ({
              path: file.path,
              ...(file.mode === undefined ? {} : { mode: file.mode }),
            })),
          }),
    },
  };
}

export function backendFromTurnInput(
  input: AgentTurnInput,
): SandboxPromptBackend | undefined {
  const declared = backendFromTurnProviderOptions(input.providerOptions);
  let backend = declared;
  if (input.profile !== undefined) {
    if (declared?.profile !== undefined &&
      canonicalAgentProfileDigest(declared.profile) !== canonicalAgentProfileDigest(input.profile)) {
      throw new Error("Tangle turn profile conflicts with its backend profile");
    }
    if (declared?.type !== undefined && input.profile.harness !== undefined && declared.type !== input.profile.harness) {
      throw new Error("Tangle turn profile conflicts with its backend harness");
    }
    // Validate payload bounds without turning the typed profile into metadata.
    backend = sandboxPromptBackend({ ...declared, profile: input.profile });
  }
  return backend;
}

/** Canonical interaction controls and backend controls must agree. */
function turnBackendOptions(
  input: AgentTurnInput,
): SandboxPromptBackend | undefined {
  const backend = backendFromTurnInput(input);
  const backendModel = backend?.model?.model;
  if (
    input.model !== undefined &&
    backendModel !== undefined &&
    backendModel !== input.model
  ) {
    throw new Error("Tangle turn model conflicts with its backend model");
  }
  if (input.interactions === undefined) return backend;
  if (backend === undefined) return { interactions: input.interactions };
  if (
    backend.interactions !== undefined &&
    !sameRequestedInteractions(backend.interactions, input.interactions)
  ) {
    throw new Error(
      "Tangle turn interactions conflict with its backend interactions",
    );
  }
  return { ...backend, interactions: input.interactions };
}

function sameRequestedInteractions(
  left: { permission?: boolean; question?: boolean; plan?: boolean },
  right: { permission?: boolean; question?: boolean; plan?: boolean },
): boolean {
  return (["permission", "question", "plan"] as const).every(
    (kind) => (left[kind] ?? false) === (right[kind] ?? false),
  );
}

type SandboxRunStatus =
  | "success"
  | "failed"
  | "blocked_on_approval"
  | "awaiting_question"
  | "awaiting_interaction"
  | "awaiting_plan_decision";

type ValidatedSandboxPromptResult = Record<string, unknown> & {
  success: boolean;
  status: SandboxRunStatus;
  durationMs: number;
  executionId?: string;
};

const SANDBOX_OPTIONAL_RESULT_FIELDS = new Set([
  "executionId",
  "response",
  "error",
  "errorCode",
  "toolInvocations",
  "approval",
  "interaction",
  "question",
  "plan",
  "traceId",
  "usage",
  "costUsd",
]);

export function validatedSandboxPromptResult(
  result: PromptResult,
): ValidatedSandboxPromptResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Tangle prompt returned no result object");
  }
  const source = result as unknown as Record<string, unknown>;
  if (
    Object.hasOwn(source, "contextTransferReceipt") &&
    source.contextTransferReceipt === undefined
  ) {
    throw new Error(
      "Tangle prompt result returned a context receipt for a turn that requested no transfer",
    );
  }
  // Keep absent SDK fields absent through the strict JSON check.
  const record = projectAgentTerminalRecord(Object.fromEntries(
    Object.entries(source).filter(
      ([field, value]) =>
        value !== undefined || !SANDBOX_OPTIONAL_RESULT_FIELDS.has(field),
    ),
  ));
  const content = boundedEventContentRecordSchema.safeParse(record);
  if (!content.success) {
    throw new Error("Tangle prompt result exceeded its JSON bound", { cause: content.error });
  }
  // Content and metadata have separate bounds; source remains untouched.
  assertBoundedJson(Object.fromEntries(
    Object.entries(record).filter(([field]) =>
      field !== "response" &&
      field !== "text" &&
      field !== "finalText"),
  ), "Tangle prompt result");
  if (typeof record.success !== "boolean") {
    throw new Error("Tangle prompt result omitted its success status");
  }
  const statuses = new Set<SandboxRunStatus>([
    "success",
    "failed",
    "blocked_on_approval",
    "awaiting_question",
    "awaiting_interaction",
    "awaiting_plan_decision",
  ]);
  if (
    typeof record.status !== "string" ||
    !statuses.has(record.status as SandboxRunStatus)
  ) {
    throw new Error("Tangle prompt result contained an invalid run status");
  }
  if (record.success !== (record.status === "success")) {
    throw new Error(
      "Tangle prompt result success flag conflicts with its run status",
    );
  }
  if (
    typeof record.durationMs !== "number" ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  ) {
    throw new Error("Tangle prompt result contained an invalid duration");
  }
  for (const field of [
    "executionId",
    "response",
    "text",
    "finalText",
    "error",
    "errorCode",
    "traceId",
  ]) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw new Error(`Tangle prompt result contained an invalid ${field}`);
    }
  }
  if (record.executionId === "") {
    throw new Error("Tangle prompt result contained an empty executionId");
  }
  tokenUsageFromData(record);
  return record as ValidatedSandboxPromptResult;
}

const AWAITING_STATUSES = new Set<SandboxRunStatus>([
  "blocked_on_approval",
  "awaiting_question",
  "awaiting_interaction",
  "awaiting_plan_decision",
]);

export function agentTurnResultFromPromptRecord(
  record: ValidatedSandboxPromptResult,
  options: {
    contextTransferRequested?: boolean;
    contextTransferRequest?: import("@tangle-network/agent-interface").ContextTransferRequest;
    sessionId?: string;
    controlRef?: AgentExactRunControlRef;
  } = {},
): AgentTurnResult {
  const controlRef = options.controlRef
    ? AgentExactRunControlRefSchema.parse(options.controlRef)
    : undefined;
  if (
    controlRef !== undefined &&
    options.sessionId !== undefined &&
    controlRef.sessionId !== options.sessionId
  ) {
    throw new Error("Tangle prompt result sessionId conflicts with its control reference");
  }
  if (
    controlRef !== undefined &&
    record.executionId !== controlRef.executionId
  ) {
    throw new Error("Tangle prompt result did not confirm its exact executionId");
  }
  const text =
    typeof record.response === "string"
      ? record.response
      : typeof record.text === "string"
        ? record.text
        : typeof record.finalText === "string"
          ? record.finalText
          : "";
  // An unsolicited transfer receipt cannot establish a handoff.
  const hasContextTransferReceipt = Object.hasOwn(
    record,
    "contextTransferReceipt",
  );
  if (hasContextTransferReceipt && options.contextTransferRequested !== true) {
    throw new Error(
      "Tangle prompt result returned a context receipt for a turn that requested no transfer",
    );
  }
  const rawContextTransferReceipt = hasContextTransferReceipt
    ? record.contextTransferReceipt
    : undefined;
  const contextTransferReceipt = ContextTransferReceiptSchema.safeParse(
    rawContextTransferReceipt,
  );
  if (hasContextTransferReceipt && !contextTransferReceipt.success) {
    throw new Error("Tangle prompt result contained an invalid context receipt");
  }
  if (
    contextTransferReceipt.success &&
    options.contextTransferRequest !== undefined &&
    !contextTransferResultMatchesRequest(
      options.contextTransferRequest,
      contextTransferReceipt.data,
    )
  ) {
    throw new Error("Tangle prompt result context receipt does not match its request");
  }
  // Preserve the credential owner's typed quota refusal and reset time.
  if (!record.success && record.errorCode === "provider_quota_exhausted") {
    const resetAt = record.resetAt;
    throw new TangleCredentialCapacityError(
      "provider_quota_exhausted",
      "exhausted",
      typeof resetAt === "string" && new Date(resetAt).toISOString() === resetAt ? resetAt : undefined,
      429,
    );
  }
  const usage = tokenUsageFromData(record);
  const awaiting = AWAITING_STATUSES.has(record.status);
  return {
    text,
    success: record.success,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(usage ? { usage } : {}),
    // Waiting for a human retains its live status.
    metadata: {
      ...(controlRef
        ? {
            runId: controlRef.runId,
            executionId: controlRef.executionId,
            requestDigest: controlRef.requestDigest,
          }
        : {}),
      status: record.status,
      awaitingInteraction: awaiting,
      terminal: !awaiting,
    },
    ...(contextTransferReceipt.success
      ? { contextTransferReceipt: contextTransferReceipt.data }
      : {}),
  };
}
