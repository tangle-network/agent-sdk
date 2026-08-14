import type {
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  type HarnessType,
  harnessSystemPromptIntents,
  snapshotAgentProfile,
} from "@tangle-network/agent-interface";
import { createCliBridgeEnvironment } from "./retained-environment.js";
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
  // The observation surfaces are declared as intent and narrowed to the
  // sources this bridge can put a value on, so the environment offers the
  // operation exactly where the document claims it.
  const resolveCapabilities = (): AgentEnvironmentCapabilities => {
    const declared = options.capabilities ?? defaultCliBridgeCapabilities();
    return declared.observation === undefined
      ? declared
      : {
          ...declared,
          observation: narrowedCliBridgeObservation(declared.observation, options),
        };
  };
  return {
    name,
    capabilities: resolveCapabilities,
    async create(input) {
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
      return createCliBridgeEnvironment({
        options,
        providerName: name,
        environmentInput,
        environmentId,
        allowDispatch: true,
        cancelRunsOnDestroy: true,
        capabilities: resolveCapabilities(),
      });
    },
    async get(id) {
      if (id.length === 0 || id.trim() !== id) {
        throw new Error("cli-bridge environment id must be non-empty and have no outer whitespace");
      }
      return createCliBridgeEnvironment({
        options,
        providerName: name,
        environmentInput: { profile: { name: "reconnected" }, idempotencyKey: id },
        environmentId: id,
        allowDispatch: false,
        cancelRunsOnDestroy: false,
        capabilities: resolveCapabilities(),
      });
    },
  };
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
