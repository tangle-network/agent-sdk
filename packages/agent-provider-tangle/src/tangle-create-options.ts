import type { BackendType, CreateSandboxOptions } from "@tangle-network/sandbox";
import {
  WorkspaceRequestSchema,
  workspaceCwdPathForBase,
} from "@tangle-network/agent-interface/environment-provider";
import type {
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
} from "./tangle-contract-safety.js";
import { sandboxResourcesFromResourceRequest } from "./tangle-resources.js";

export function sandboxOptionsFromCreateInput(
  input: CreateAgentEnvironmentInput,
  defaultBackend: BackendType,
  parsedWorkspace?: WorkspaceRequest,
): CreateSandboxOptions {
  const workspace = assertCreateInputShape(input, parsedWorkspace) ?? {};
  assertNoInlineSecretValues(input, workspace);
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
  if (input.resources?.providerOptions && Object.keys(input.resources.providerOptions).length > 0) {
    throw new Error("Tangle resource providerOptions are not supported");
  }
  if (input.resources?.providerOptions) assertBoundedRecord(input.resources.providerOptions, "Tangle resource providerOptions");
  if (input.idempotencyKey !== undefined) {
    boundedIdentifier(input.idempotencyKey, "Tangle idempotency key");
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
    ...(input.env ? { env: input.env } : {}),
    ...(Array.isArray(input.secrets) ? { secrets: input.secrets } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    backend: {
      ...(base.backend ?? {}),
      type: (input.backend ?? defaultBackend) as BackendType,
      profile: inlineAgentProfile(input.profile),
    },
  };
  return mapped;
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
    assertBoundedJson(input.providerOptions);
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
    assertBoundedJson(input.resources.providerOptions);
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
    "metadata",
    "name",
    "idempotencyKey",
    "signal",
    "providerOptions",
  ]) keys.delete(key);
  if (keys.size > 0) throw new Error("Tangle create input contains unsupported fields");
  if (typeof input.profile === "string") {
    boundedIdentifier(input.profile, "Tangle profile reference");
  } else {
    if (!input.profile || typeof input.profile !== "object" || Array.isArray(input.profile)) {
      throw new Error("Tangle profile must be an object or bounded reference");
    }
    assertBoundedJson(input.profile);
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
  assertBoundedJson(options);
  if (Object.hasOwn(options, "providerOptions")) {
    throw new Error("Tangle mapped create providerOptions are not supported");
  }
  if (options.name !== undefined) {
    boundedString(options.name, "Tangle mapped environment name");
    if (!options.name) throw new Error("Tangle mapped environment name cannot be empty");
  }
  if (options.idempotencyKey !== undefined) boundedIdentifier(options.idempotencyKey, "Tangle mapped idempotency key");
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
  assertBoundedJson(profile);
  return profile;
}

function assertBoundedRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  assertBoundedJson(value);
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
