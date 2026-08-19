import { createAgentEnvironmentWithIdempotency } from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentCreateIdempotencyRecord,
  AgentEnvironmentProvider,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  type HarnessType,
  harnessTypeSchema,
  harnessSystemPromptIntents,
  snapshotAgentProfile,
} from "@tangle-network/agent-interface";
import {
  createCliBridgeEnvironment,
} from "./retained-environment.js";
import {
  supportsCliBridgeNativeInteractions,
} from "./retained-native.js";
import {
  assertCliBridgeProviderOptions,
  type CliBridgeProviderOptions,
} from "./provider-options.js";
import { narrowedCliBridgeObservation } from "./observation.js";

export type { CliBridgeProviderOptions } from "./provider-options.js";
export { safeEndpointFromBaseUrl } from "./observation.js";

export function createCliBridgeProvider(
  options: CliBridgeProviderOptions,
): AgentEnvironmentProvider {
  assertCliBridgeProviderOptions(options);
  const name = options.name ?? "cli-bridge";
  const createRecords = new Map<
    string,
    AgentEnvironmentCreateIdempotencyRecord<AgentEnvironment>
  >();
  const configuredBackend = selectedBackendFromRoute(options.defaultModel);
  // The observation surfaces are declared as intent and narrowed to the
  // sources this bridge can put a value on, so the environment offers the
  // operation exactly where the document claims it.
  const resolveCapabilities = (
    selectedBackend?: string,
  ): AgentEnvironmentCapabilities => {
    const parsedHarness = harnessTypeSchema.safeParse(selectedBackend);
    const declared =
      options.capabilities ??
      defaultCliBridgeCapabilities(parsedHarness.success ? parsedHarness.data : undefined);
    const narrowed = declared.observation === undefined
      ? declared
      : {
          ...declared,
          observation: narrowedCliBridgeObservation(declared.observation, options),
        };
    if (selectedBackend !== undefined && supportsCliBridgeNativeInteractions(narrowed, selectedBackend)) {
      return narrowed;
    }
    const { interactions: _interactions, ...withoutInteractions } = narrowed;
    return withoutInteractions;
  };
  const createEnvironment = async (
    input: CreateAgentEnvironmentInput,
  ): Promise<AgentEnvironment> => {
    if (typeof input.profile === "string") {
      throw new Error(
        `createCliBridgeProvider requires an inline AgentProfile; named profile "${input.profile}" is unsupported`,
      );
    }
    const environmentInput: CreateAgentEnvironmentInput = {
      ...input,
      profile: snapshotAgentProfile(input.profile),
    };
    const environmentId = input.idempotencyKey ?? crypto.randomUUID();
    const selectedBackend = selectedBackendFromInput(
      environmentInput,
      configuredBackend,
    );
    return createCliBridgeEnvironment({
      options,
      providerName: name,
      environmentInput,
      environmentId,
      allowDispatch: true,
      cancelRunsOnDestroy: true,
      capabilities: resolveCapabilities(selectedBackend),
      selectedBackend,
    });
  };
  return {
    name,
    capabilities: () => resolveCapabilities(configuredBackend),
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
      const selectedBackend = configuredBackend ?? (
        options.capabilities !== undefined &&
        supportsCliBridgeNativeInteractions(options.capabilities, "pi")
          ? "pi"
          : undefined
      );
      return createCliBridgeEnvironment({
        options,
        providerName: name,
        environmentInput: { profile: { name: "reconnected" }, idempotencyKey: id },
        environmentId: id,
        allowDispatch: false,
        cancelRunsOnDestroy: false,
        capabilities: resolveCapabilities(selectedBackend),
        selectedBackend,
      });
    },
  };
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
