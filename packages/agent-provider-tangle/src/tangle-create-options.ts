import {
  assertCliAuthReferenceSupported,
  cliAuthReferenceSchema,
} from "@tangle-network/sandbox/auth";
import {
  parseBackendType,
  type BackendType,
  type CreateSandboxOptions,
} from "@tangle-network/sandbox";
import {
  AgentEnvironmentEgressPolicySchema,
  WorkspaceRequestSchema,
  workspaceCwdPathForBase,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentEnvironmentEgressPolicy,
  AgentProfileRef,
  CreateAgentEnvironmentInput,
  WorkspaceRequest,
} from "@tangle-network/agent-interface/environment-provider";
import {
  assertBoundedJson,
  boundedIdentifier,
  boundedString,
  MAX_ARRAY_LENGTH,
  MAX_MAP_ENTRIES,
  PROFILE_AT_BACKEND_PROFILE,
  PROFILE_AT_ROOT,
} from "./tangle-contract-safety.js";
import { profileCredentialSource } from "./model-credential-source.js";
import { sandboxResourcesFromResourceRequest } from "./tangle-resources.js";
import { tangleRuntimeAttachments } from "./tangle-runtime-attachments.js";
import type { TangleModelCredentials } from "./tangle-types.js";

/** Immutable create evidence used to bind a later native resume to its restored snapshot. */
export const NATIVE_RESUME_CHECKPOINT_METADATA_KEY = "tangleNativeResumeCheckpointId";

export function captureModelCredentials(
  value: TangleModelCredentials | undefined,
): TangleModelCredentials | undefined {
  if (value === undefined) return undefined;
  assertBoundedJson(value, "Tangle modelCredentials");
  if (value && typeof value === "object" && !Array.isArray(value) && "cliAuth" in value) {
    if (Object.keys(value).some((key) => key !== "cliAuth")) {
      throw new Error("Tangle native modelCredentials accepts only cliAuth");
    }
    const parsed = cliAuthReferenceSchema.safeParse(value.cliAuth);
    if (!parsed.success) throw new Error("Tangle modelCredentials cliAuth must be a valid stored-secret reference");
    return Object.freeze({ cliAuth: Object.freeze(parsed.data) });
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "apiKeyEnv" && key !== "baseUrl")) {
    throw new Error("Tangle modelCredentials accepts only apiKeyEnv and baseUrl");
  }
  const { apiKeyEnv, baseUrl } = value as { apiKeyEnv: string; baseUrl: string };
  if (typeof apiKeyEnv !== "string" || apiKeyEnv.length > 128 ||
    !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("Tangle modelCredentials apiKeyEnv must be a stored secret name");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Tangle modelCredentials baseUrl must be an HTTP(S) endpoint");
  }
  if (typeof baseUrl !== "string" || baseUrl.length > 2048 || /\s/.test(baseUrl) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash) {
    throw new Error("Tangle modelCredentials baseUrl must be an HTTP(S) endpoint without credentials, query, or fragment");
  }
  return Object.freeze({ apiKeyEnv, baseUrl });
}

export function sandboxOptionsFromCreateInput(
  input: CreateAgentEnvironmentInput,
  defaultBackend?: BackendType,
  parsedWorkspace?: WorkspaceRequest,
  modelCredentials?: TangleModelCredentials,
  subscriptionSelection = false,
): CreateSandboxOptions {
  const workspace = assertCreateInputShape(input, parsedWorkspace) ?? {};
  const profile = inlineAgentProfile(input.profile);
  const backend =
    input.backend === undefined
      ? parseBackendType(defaultBackend ?? profile.harness ?? "opencode")
      : (input.backend as BackendType);
  assertNoInlineSecretValues(input, workspace);
  const selectedSecret = modelCredentials === undefined ? undefined
    : "cliAuth" in modelCredentials ? modelCredentials.cliAuth?.secretEnv : modelCredentials.apiKeyEnv;
  const nativeCredentials = modelCredentials !== undefined && "cliAuth" in modelCredentials;
  if (modelCredentials !== undefined && selectedSecret === undefined) {
    throw new Error("Tangle modelCredentials must select a stored secret");
  }
  if ((nativeCredentials || subscriptionSelection) &&
    (profile.harness === undefined || profile.harness !== backend)) {
    throw new Error("Tangle selected modelCredentials must use the exact profile harness");
  }
  if (nativeCredentials) {
    if (profileCredentialSource(profile) !== "subscription") {
      throw new Error("Tangle native credentials require subscription intent in the exact profile");
    }
    assertCliAuthReferenceSupported(backend, modelCredentials);
  }
  if (selectedSecret !== undefined && Object.hasOwn(input.env ?? {}, selectedSecret)) {
    throw new Error("Tangle modelCredentials cannot shadow a stored secret with inline environment data");
  }
  const requestedSecrets = Array.isArray(input.secrets) ? input.secrets : undefined;
  const secrets = selectedSecret !== undefined
    ? [...new Set([...(requestedSecrets ?? []), selectedSecret])]
    : requestedSecrets;
  if (secrets !== undefined && secrets.length > MAX_ARRAY_LENGTH) {
    throw new Error("Tangle selected credential exceeds the stored-secret grant bound");
  }
  const recordsCredential = nativeCredentials || subscriptionSelection;
  if (recordsCredential && Object.hasOwn(input.metadata ?? {}, "modelCredentials")) {
    throw new Error("Tangle credential selection owns metadata.modelCredentials");
  }
  if (Object.hasOwn(input.metadata ?? {}, NATIVE_RESUME_CHECKPOINT_METADATA_KEY)) {
    throw new Error("Tangle owns the native resume checkpoint metadata");
  }
  const metadata = {
    ...input.metadata,
    ...(recordsCredential ? { modelCredentials } : {}),
    ...(workspace.checkpoint === undefined ? {} : {
      [NATIVE_RESUME_CHECKPOINT_METADATA_KEY]: boundedIdentifier(
        workspace.checkpoint.checkpointId,
        "Tangle native resume checkpoint id",
      ),
    }),
  };
  if (input.providerOptions && Object.keys(input.providerOptions).length > 0) {
    throw new Error("Tangle create providerOptions are not supported");
  }
  if (input.providerOptions) assertBoundedRecord(input.providerOptions, "Tangle create providerOptions");
  if (input.metadata) assertBoundedRecord(input.metadata, "Tangle metadata");
  if (input.name !== undefined) {
    boundedString(input.name, "Tangle environment name");
    if (!input.name) throw new Error("Tangle environment name cannot be empty");
  }
  if (input.backend !== undefined) boundedIdentifier(input.backend, "Tangle backend");
  if (input.env !== undefined) assertStringRecord(input.env, "Tangle");
  if (workspace.providerOptions && Object.keys(workspace.providerOptions).length > 0) {
    throw new Error("Tangle workspace providerOptions are not supported");
  }
  const workspaceCwd = workspaceCwdPathForBase(
    workspace.cwd,
    "repository",
    "Tangle",
  );
  const restore = sandboxRestoreFromCheckpoint(workspace.checkpoint);
  if (input.resources?.providerOptions && Object.keys(input.resources.providerOptions).length > 0) {
    throw new Error("Tangle resource providerOptions are not supported");
  }
  if (input.resources?.providerOptions) assertBoundedRecord(input.resources.providerOptions, "Tangle resource providerOptions");
  if (input.idempotencyKey !== undefined) {
    boundedIdentifier(input.idempotencyKey, "Tangle idempotency key");
  }
  if (input.billingOwner !== undefined) {
    boundedIdentifier(input.billingOwner, "Tangle billing owner");
  }
  const resources = sandboxResourcesFromResourceRequest(input.resources);
  // Sandbox injects secrets by name from its own store. Accepting a name/value
  // record and dropping it would create an environment with no credentials and
  // no error, surfacing later as an unexplained tool failure.
  const environment = workspace.image ?? workspace.environment;
  const base: CreateSandboxOptions = {};
  const mapped = {
    ...base,
    ...(environment !== undefined ? { environment } : {}),
    ...(workspaceCwd === undefined ? {} : { cwd: workspaceCwd }),
    ...(workspace.repoUrl
      ? {
          git: {
            url: boundedString(workspace.repoUrl, "Tangle repository URL"),
            ...(workspace.gitRef ? { ref: boundedIdentifier(workspace.gitRef, "Tangle git ref") } : {}),
          },
        }
      : {}),
    ...(resources ? { resources } : {}),
    ...(restore ?? {}),
    ...(input.env ? { env: input.env } : {}),
    ...(Array.isArray(secrets) ? { secrets } : {}),
    ...(input.egress === undefined ? {} : { egressPolicy: sandboxEgressPolicy(input.egress) }),
    ...(input.billingOwner === undefined ? {} : { billingOwnerId: input.billingOwner }),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    backend: {
      ...(base.backend ?? {}),
      type: backend,
      profile,
      ...(modelCredentials === undefined ? {} : {
        model: "cliAuth" in modelCredentials
          ? { ...modelCredentials, authMode: "oauth" as const } : modelCredentials,
      }),
      ...(input.runtimeAttachments === undefined ? {} : {
        runtimeAttachments: tangleRuntimeAttachments(input.runtimeAttachments, profile),
      }),
    },
  };
  return mapped;
}

/**
 * Project a portable workspace checkpoint onto the Sandbox restore fields.
 *
 * A Tangle checkpoint is a snapshot of its source box, and Sandbox names a snapshot by the pair
 * (snapshot id, source box id). The source box may already be deleted.
 */
export function sandboxRestoreFromCheckpoint(
  checkpoint: WorkspaceRequest["checkpoint"],
): { fromSnapshot: string; fromSandboxId: string } | undefined {
  if (checkpoint === undefined) return undefined;
  return {
    fromSnapshot: boundedIdentifier(checkpoint.checkpointId, "Tangle workspace checkpoint id"),
    fromSandboxId: boundedIdentifier(checkpoint.source.environmentId, "Tangle workspace checkpoint source"),
  };
}

/**
 * Project the portable egress policy onto the Sandbox policy.
 *
 * The schema is a strict discriminated union, so a domain list outside `strict` is refused rather
 * than sent: Sandbox IGNORES `allowDomains` in `open` and `blocked` mode, and a silently ignored
 * allowlist is a policy the caller believes is in force and is not.
 *
 * `includeImplicitDomains` stays unset, which is the Sandbox default of false. A strict policy
 * therefore reaches the named domains plus the model endpoints the platform provisioned, matching
 * what {@link AgentEnvironmentEgressPolicy} states; opting in would silently add ~40 hosts,
 * including public source hosts.
 */
function sandboxEgressPolicy(
  policy: AgentEnvironmentEgressPolicy,
): NonNullable<CreateSandboxOptions["egressPolicy"]> {
  const parsed = AgentEnvironmentEgressPolicySchema.parse(policy);
  if (parsed.mode !== "strict") return { mode: parsed.mode };
  return {
    mode: "strict",
    ...(parsed.allowDomains === undefined ? {} : { allowDomains: [...parsed.allowDomains] }),
  };
}

/** Reject value-bearing secret maps before any custom mapper can drop them. */
export function assertNoInlineSecretValues(
  input: CreateAgentEnvironmentInput,
  parsedWorkspace?: WorkspaceRequest,
): void {
  if (input.providerOptions !== undefined) {
    if (!input.providerOptions || typeof input.providerOptions !== "object" || Array.isArray(input.providerOptions)) {
      throw new Error("Tangle create providerOptions must be a JSON object");
    }
    assertBoundedJson(input.providerOptions, "Tangle create providerOptions");
    if (Object.keys(input.providerOptions).length > 0) {
      throw new Error("Tangle create providerOptions are not supported");
    }
  }
  if (input.workspace?.providerOptions !== undefined) {
    const workspace = parsedWorkspace ?? WorkspaceRequestSchema.parse(input.workspace);
    if (workspace.providerOptions && Object.keys(workspace.providerOptions).length > 0) {
      throw new Error("Tangle workspace providerOptions are not supported");
    }
  }
  if (input.resources?.providerOptions !== undefined) {
    if (!input.resources.providerOptions || typeof input.resources.providerOptions !== "object" || Array.isArray(input.resources.providerOptions)) {
      throw new Error("Tangle resource providerOptions must be a JSON object");
    }
    assertBoundedJson(input.resources.providerOptions, "Tangle create resources.providerOptions");
    if (Object.keys(input.resources.providerOptions).length > 0) {
      throw new Error("Tangle resource providerOptions are not supported");
    }
  }
  if (input.secrets !== undefined && !Array.isArray(input.secrets)) {
    throw new Error(
      "Tangle secrets must be an array of names created with client.secrets.create(); inline secret values are not accepted",
    );
  }
  if (input.secrets !== undefined) {
    if (input.secrets.length > MAX_ARRAY_LENGTH) {
      throw new Error("Tangle secret names exceed their bound");
    }
    for (const secret of input.secrets) boundedIdentifier(secret, "Tangle secret name");
  }
}

/** A custom mapper must not smuggle a value map into the Sandbox request. */
export function assertMappedSecretNames(options: CreateSandboxOptions): void {
  if (options.secrets !== undefined && !Array.isArray(options.secrets)) {
    throw new Error("Tangle mapped secrets must be an array of stored secret names");
  }
  if (options.secrets !== undefined) {
    if (options.secrets.length > MAX_ARRAY_LENGTH) {
      throw new Error("Tangle mapped secrets exceed their bound");
    }
    for (const secret of options.secrets) boundedIdentifier(secret, "Tangle mapped secret name");
  }
}

export function assertCreateInputShape(
  input: CreateAgentEnvironmentInput,
  parsedWorkspace?: WorkspaceRequest,
): WorkspaceRequest | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tangle create input must be an object");
  }
  const keys = new Set(Object.keys(input));
  for (const key of [
    "profile",
    "backend",
    "workspace",
    "resources",
    "env",
    "secrets",
    "egress",
    "billingOwner",
    "metadata",
    "name",
    "idempotencyKey",
    "signal",
    "providerOptions",
    "runtimeAttachments",
  ]) keys.delete(key);
  if (keys.size > 0) throw new Error("Tangle create input contains unsupported fields");
  if (input.runtimeAttachments !== undefined) {
    tangleRuntimeAttachments(input.runtimeAttachments, typeof input.profile === "object" ? input.profile : undefined);
  }
  if (typeof input.profile === "string") {
    boundedIdentifier(input.profile, "Tangle profile reference");
  } else {
    if (!input.profile || typeof input.profile !== "object" || Array.isArray(input.profile)) {
      throw new Error("Tangle profile must be an object or bounded reference");
    }
    assertBoundedJson(input.profile, "Tangle create profile", PROFILE_AT_ROOT);
  }
  if (input.resources !== undefined) {
    if (!input.resources || typeof input.resources !== "object" || Array.isArray(input.resources)) {
      throw new Error("Tangle resources must be an object");
    }
    const resourceKeys = new Set(Object.keys(input.resources));
    for (const key of ["cpu", "memoryMb", "diskMb", "gpu", "providerOptions"]) resourceKeys.delete(key);
    if (resourceKeys.size > 0) throw new Error("Tangle resources contain unsupported fields");
  }
  if (input.workspace === undefined) return undefined;
  const workspace = parsedWorkspace ?? WorkspaceRequestSchema.parse(input.workspace);
  workspaceCwdPathForBase(workspace.cwd, "repository", "Tangle");
  return workspace;
}

export function assertMappedCreateOptions(options: CreateSandboxOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Tangle mapped create options must be an object");
  }
  assertBoundedJson(options, "Tangle mapped create options", PROFILE_AT_BACKEND_PROFILE);
  if (options.backend?.model?.cliAuth !== undefined) {
    if (options.backend.type === undefined) {
      throw new Error("Tangle mapped native credentials require the selected backend type");
    }
    assertCliAuthReferenceSupported(options.backend.type, options.backend.model);
    if (options.backend.profile === undefined || profileCredentialSource(options.backend.profile) !== "subscription") {
      throw new Error("Tangle mapped native credentials require subscription intent in the exact profile");
    }
    if (options.backend.profile?.harness !== undefined && options.backend.profile.harness !== options.backend.type) {
      throw new Error("Tangle mapped native credentials must use the exact profile harness");
    }
    const selectedSecret = options.backend.model.cliAuth.secretEnv;
    if (!Array.isArray(options.secrets) || !options.secrets.includes(selectedSecret)) {
      throw new Error("Tangle mapped native credential must be explicitly listed in create secrets");
    }
    if (Object.hasOwn(options.env ?? {}, selectedSecret)) {
      throw new Error("Tangle mapped native credential cannot shadow a stored secret with inline environment data");
    }
  }
  if (options.backend?.runtimeAttachments !== undefined) {
    tangleRuntimeAttachments(options.backend.runtimeAttachments, options.backend.profile);
  }
  if (Object.hasOwn(options, "providerOptions")) {
    throw new Error("Tangle mapped create providerOptions are not supported");
  }
  if (options.name !== undefined) {
    boundedString(options.name, "Tangle mapped environment name");
    if (!options.name) throw new Error("Tangle mapped environment name cannot be empty");
  }
  if (options.idempotencyKey !== undefined) boundedIdentifier(options.idempotencyKey, "Tangle mapped idempotency key");
  if (options.billingOwnerId !== undefined) boundedIdentifier(options.billingOwnerId, "Tangle mapped billing owner");
  if (options.egressPolicy !== undefined) {
    if (!options.egressPolicy || typeof options.egressPolicy !== "object" || Array.isArray(options.egressPolicy)) {
      throw new Error("Tangle mapped egress policy must be an object");
    }
    if (!["open", "strict", "blocked"].includes(options.egressPolicy.mode)) {
      throw new Error("Tangle mapped egress policy mode is invalid");
    }
    if (options.egressPolicy.mode !== "strict" && options.egressPolicy.allowDomains !== undefined) {
      throw new Error("Tangle mapped egress policy allows domains only in strict mode");
    }
    // The default path is schema-checked, so this gate holds a custom mapper to the same shape.
    // A non-string or padded host reaches the platform, matches nothing, and leaves the caller
    // believing an allowlist is in force that is not.
    if (options.egressPolicy.allowDomains !== undefined) {
      if (!Array.isArray(options.egressPolicy.allowDomains)) {
        throw new Error("Tangle mapped egress allowed domains must be an array");
      }
      if (options.egressPolicy.allowDomains.length > MAX_ARRAY_LENGTH) {
        throw new Error("Tangle mapped egress allowed domains exceed their bound");
      }
      for (const domain of options.egressPolicy.allowDomains) {
        boundedIdentifier(domain, "Tangle mapped egress allowed domain");
      }
    }
  }
  if (options.env !== undefined) assertStringRecord(options.env, "Tangle mapped");
  assertMappedSecretNames(options);
}

function inlineAgentProfile(profile: AgentProfileRef): Exclude<AgentProfileRef, string> {
  if (typeof profile === "string") {
    throw new Error("Tangle provider requires an inline AgentProfile, not a profile reference");
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Tangle inline AgentProfile must be an object");
  }
  assertBoundedJson(profile, "Tangle inline AgentProfile", PROFILE_AT_ROOT);
  return profile;
}

function assertBoundedRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  assertBoundedJson(value, label);
}

function assertStringRecord(value: Record<string, string>, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} environment must be a JSON object`);
  }
  if (Object.keys(value).length > MAX_MAP_ENTRIES) {
    throw new Error(`${label} environment has too many variables`);
  }
  for (const [key, entry] of Object.entries(value)) {
    boundedIdentifier(key, `${label} environment variable name`);
    boundedString(entry, `${label} environment variable value`);
  }
}
