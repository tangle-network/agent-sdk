import {
  agentEnvironmentCreateInputDigest,
  createAgentEnvironmentWithIdempotency,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentCreateIdempotencyRecord,
  AgentEnvironmentProvider,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  type AgentExactRunControlRef,
  type HarnessType,
  harnessTypeSchema,
  harnessSystemPromptIntents,
  snapshotAgentProfile,
} from "@tangle-network/agent-interface";
import {
  createCliBridgeEnvironment,
} from "./retained-environment.js";
import {
  lookupExactCliBridgeRun,
  type CliBridgeRunLookupInput,
} from "./retained-control.js";
import {
  cachedCliBridgeCapabilityDiscovery,
  narrowCliBridgeCapabilities,
} from "./capability-discovery.js";
import {
  supportsCliBridgeNativeInteractions,
} from "./retained-native.js";
import {
  assertCliBridgeProviderOptions,
  type CliBridgeProviderOptions,
} from "./provider-options.js";
import { narrowedCliBridgeObservation } from "./observation.js";
import {
  cliBridgeEnvironmentId,
  cliBridgeEnvironmentRoute,
} from "./environment-identity.js";
import { resolveBridgeModel } from "./wire.js";

export type { CliBridgeProviderOptions } from "./provider-options.js";
export type { CliBridgeExecution } from "./provider-options.js";
export type { CliBridgeRunLookupInput } from "./retained-control.js";
export { safeEndpointFromBaseUrl } from "./observation.js";

export interface CliBridgeProvider extends AgentEnvironmentProvider {
  /** Recover the server-issued digest for one pre-dispatch retained admission. */
  lookupRun(input: CliBridgeRunLookupInput): Promise<AgentExactRunControlRef | null>;
}

export function createCliBridgeProvider(
  options: CliBridgeProviderOptions,
): CliBridgeProvider {
  assertCliBridgeProviderOptions(options);
  const name = options.name ?? "cli-bridge";
  const createRecords = new Map<
    string,
    AgentEnvironmentCreateIdempotencyRecord<AgentEnvironment>
  >();
  const configuredBackend = selectedBackendFromRoute(options.defaultModel);
  const discoverCapabilities = cachedCliBridgeCapabilityDiscovery(options);
  const remotelyVerifiedRoutes = new Set<string>();
  // The observation surfaces are declared as intent and narrowed to the
  // sources this bridge can put a value on, so the environment offers the
  // operation exactly where the document claims it.
  const localCapabilities = (
    selectedBackend?: string,
    allowNativeInteractions = false,
  ): AgentEnvironmentCapabilities => {
    const parsedHarness = harnessTypeSchema.safeParse(selectedBackend);
    const adapter = defaultCliBridgeCapabilities(
      parsedHarness.success ? parsedHarness.data : undefined,
    );
    const declared = options.capabilities === undefined
      ? adapter
      : narrowCliBridgeCapabilities(adapter, options.capabilities, selectedBackend);
    const narrowed = declared.observation === undefined
      ? declared
      : {
          ...declared,
          observation: narrowedCliBridgeObservation(declared.observation, options),
        };
    if (
      allowNativeInteractions &&
      supportsCliBridgeNativeInteractions(narrowed, selectedBackend)
    ) {
      return narrowed;
    }
    const { interactions: _interactions, ...withoutInteractions } = narrowed;
    return withoutInteractions;
  };
  const resolveCapabilities = (
    selectedBackend?: string,
    model?: string,
    allowNativeInteractions = false,
    discoverRemote = false,
  ): AgentEnvironmentCapabilities | Promise<AgentEnvironmentCapabilities> => {
    const local = localCapabilities(selectedBackend, allowNativeInteractions);
    if (options.capabilities !== undefined) return local;
    if (model === undefined) return withoutRemoteRetainedCapabilities(local);
    if (!discoverRemote) return withoutRemoteRetainedCapabilities(local);
    return discoverCapabilities(model).then((reported) => {
      return narrowCliBridgeCapabilities(local, reported, selectedBackend, {
        preserveAdapterObservation: true,
      });
    });
  };
  const createEnvironment = async (
    input: CreateAgentEnvironmentInput,
  ): Promise<AgentEnvironment> => {
    if (typeof input.profile === "string") {
      throw new Error(
        `createCliBridgeProvider requires an inline AgentProfile; named profile "${input.profile}" is unsupported`,
      );
    }
    const profile = snapshotAgentProfile(input.profile);
    const environmentInput: CreateAgentEnvironmentInput = {
      ...input,
      profile,
    };
    const selectedBackend = selectedBackendFromInput(
      environmentInput,
      configuredBackend,
    );
    const hasEnvironmentModel = selectedBackend !== undefined ||
      options.defaultModel !== undefined ||
      profile.model?.default !== undefined;
    const model = hasEnvironmentModel
      ? resolveBridgeModel(options, environmentInput, {}, profile)
      : undefined;
    const environmentId = cliBridgeEnvironmentId(
      { backend: selectedBackend, model },
      agentEnvironmentCreateInputDigest(environmentInput),
      input.idempotencyKey,
    );
    return createCliBridgeEnvironment({
      options,
      providerName: name,
      environmentInput,
      environmentId,
      allowDispatch: true,
      cancelRunsOnDestroy: true,
      capabilities: await resolveCapabilities(
        selectedBackend,
        model,
        true,
        selectedBackend === "pi" ||
          (model !== undefined && remotelyVerifiedRoutes.has(model)),
      ),
      selectedBackend,
      selectedModel: model,
    });
  };
  return {
    name,
    lookupRun: (input) => lookupExactCliBridgeRun(options, name, input),
    capabilities: () => {
      if (options.defaultModel !== undefined) {
        remotelyVerifiedRoutes.add(options.defaultModel);
      }
      return resolveCapabilities(configuredBackend, options.defaultModel, true, true);
    },
    create(input) {
      return createAgentEnvironmentWithIdempotency(
        createRecords,
        input,
        () => createEnvironment(input),
      );
    },
    async get(id) {
      if (id.length === 0 || id.trim() !== id) {
        throw new Error("cli-bridge environment id must be non-empty and have no outer whitespace");
      }
      const route = cliBridgeEnvironmentRoute(id);
      return createCliBridgeEnvironment({
        options,
        providerName: name,
        environmentInput: {
          profile: { name: "reconnected" },
          ...(route.backend === undefined ? {} : { backend: route.backend }),
          idempotencyKey: id,
        },
        environmentId: id,
        allowDispatch: false,
        cancelRunsOnDestroy: false,
        capabilities: await resolveCapabilities(
          route.backend,
          route.model,
          true,
          true,
        ),
        selectedBackend: route.backend,
        selectedModel: route.model,
      });
    },
  };
}

function withoutRemoteRetainedCapabilities(
  capabilities: AgentEnvironmentCapabilities,
): AgentEnvironmentCapabilities {
  const {
    retainedControl: _retainedControl,
    nativeContinuation: _nativeContinuation,
    interactions: _interactions,
    ...local
  } = capabilities;
  return local;
}

function selectedBackendFromInput(
  input: CreateAgentEnvironmentInput,
  configuredBackend?: string,
): string | undefined {
  if (input.backend !== undefined) return input.backend;
  if (typeof input.profile !== "string" && input.profile.harness !== undefined) {
    return input.profile.harness;
  }
  return configuredBackend;
}

function selectedBackendFromRoute(route: string | undefined): HarnessType | undefined {
  const candidate = route?.split("/", 1)[0];
  const parsed = harnessTypeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Describe the bridge backend, not this adapter.
 *
 * The adapter forwards an AgentProfile but does not own harness prompt controls.
 */
export function defaultCliBridgeCapabilities(
  harness?: HarnessType,
): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: false,
      systemPrompt: harnessSystemPromptIntents(harness),
      instructions: true,
      tools: true,
      permissions: true,
      mcp: true,
      subagents: true,
      resources: {
        files: true,
        instructions: true,
        tools: true,
        skills: true,
        agents: true,
        commands: true,
      },
      hooks: false,
      modes: true,
      runtimeUpdate: false,
      validation: false,
    },
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, list: false, messages: false },
    retainedControl: {
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    },
    ...(harness === "pi"
      ? {
          nativeContinuation: {
            atomicBoundary: true,
            requestIdempotency: true,
          },
        }
      : {}),
    ...(harness === "pi"
      ? {
          interactions: {
            kinds: ["permission"],
            answerFieldTypes: ["select"],
            responseScopes: ["interaction"],
            secretAnswers: false,
            concurrentRequests: false,
            replay: true,
            responseIdempotency: true,
          },
        }
      : {}),
    workspace: {
      read: false,
      write: false,
      exec: false,
      git: false,
      upload: false,
      download: false,
    },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: true,
    confidential: false,
    // cli-bridge measures what a turn cost and where it forwarded that turn.
    // It provisions no compute and holds no account, so the surfaces that
    // describe provisioned resources and billing are never claimed.
    observation: {
      identity: true,
      lifecycle: true,
      endpoint: true,
      placement: true,
      resources: false,
      resourceUse: false,
      modelUsage: true,
      computeBilling: false,
      accountUsage: false,
    },
  };
}
