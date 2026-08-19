import {
  AgentEnvironmentCapabilitiesSchema,
  type AgentEnvironmentCapabilities,
} from "@tangle-network/agent-interface/environment-provider";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import {
  supportsCliBridgeNativeContinuation,
  supportsCliBridgeNativeInteractions,
} from "./retained-native.js";
import {
  createCliBridgeTransport,
  requestHeaders,
  trimSlash,
} from "./transport.js";

/** Read the retained contract from the exact Bridge model route. */
export async function discoverCliBridgeCapabilities(
  options: CliBridgeProviderOptions,
  model: string,
): Promise<AgentEnvironmentCapabilities> {
  const transport = createCliBridgeTransport(options);
  try {
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/capabilities?model=${encodeURIComponent(model)}`,
      {
        method: "GET",
        headers: requestHeaders(options),
      },
    );
    if (!response.ok) {
      throw new Error(
        `cli-bridge capability discovery returned HTTP ${response.status}: ${await response.text()}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(await response.text());
    } catch (error) {
      throw new Error("cli-bridge capability discovery returned invalid JSON", { cause: error });
    }
    const parsed = AgentEnvironmentCapabilitiesSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("cli-bridge capability discovery returned an invalid capability document", {
        cause: parsed.error,
      });
    }
    return parsed.data as AgentEnvironmentCapabilities;
  } finally {
    await transport.close();
  }
}

/** Share one readiness request between capability checks and environment creation. */
export function cachedCliBridgeCapabilityDiscovery(
  options: CliBridgeProviderOptions,
): (model: string) => Promise<AgentEnvironmentCapabilities> {
  const cache = new Map<string, Promise<AgentEnvironmentCapabilities>>();
  return (model) => {
    const existing = cache.get(model);
    if (existing) return existing;
    const pending = discoverCliBridgeCapabilities(options, model);
    cache.set(model, pending);
    void pending.catch(() => {
      if (cache.get(model) === pending) cache.delete(model);
    });
    return pending;
  };
}

/**
 * Publish only operations implemented by this adapter and proved by Bridge.
 *
 * Bridge owns backend truth. This provider owns its HTTP adapter and local
 * observation surfaces. A remote capability cannot create a provider method.
 */
export function narrowCliBridgeCapabilities(
  adapter: AgentEnvironmentCapabilities,
  reported: AgentEnvironmentCapabilities,
  selectedBackend?: string,
  options: { preserveAdapterObservation?: boolean } = {},
): AgentEnvironmentCapabilities {
  const streaming = {
    live: adapter.streaming.live && reported.streaming.live,
    replay: adapter.streaming.replay && reported.streaming.replay,
    detach: adapter.streaming.detach && reported.streaming.detach,
    turnIdempotency:
      adapter.streaming.turnIdempotency && reported.streaming.turnIdempotency,
  };
  const nativeContinuation =
    supportsCliBridgeNativeContinuation(adapter) &&
    supportsCliBridgeNativeContinuation(reported)
      ? { atomicBoundary: true, requestIdempotency: true }
      : undefined;
  const sessions = {
    continue:
      nativeContinuation !== undefined &&
      adapter.sessions.continue &&
      reported.sessions.continue,
    // The Bridge can list and inspect sessions, but this adapter exposes neither method.
    list: false,
    messages: false,
  };
  const retainedControl =
    sessions.continue &&
    supportsRetainedControl(adapter) &&
    supportsRetainedControl(reported)
      ? {
          exactRunIdentity: true,
          resultIdentity: true,
          eventIdentity: true,
          cancellationIdempotency: true,
        }
      : undefined;
  const interactions =
    supportsCliBridgeNativeInteractions(adapter, selectedBackend) &&
    supportsCliBridgeNativeInteractions(reported, selectedBackend)
      ? adapter.interactions
      : undefined;
  const observation = options.preserveAdapterObservation
    ? adapter.observation
    : intersectObservation(adapter.observation, reported.observation);
  const candidate = {
    profile: {
      namedProfiles: adapter.profile.namedProfiles && reported.profile.namedProfiles,
      systemPrompt: {
        replace: adapter.profile.systemPrompt.replace && reported.profile.systemPrompt.replace,
        append: adapter.profile.systemPrompt.append && reported.profile.systemPrompt.append,
      },
      instructions: adapter.profile.instructions && reported.profile.instructions,
      tools: adapter.profile.tools && reported.profile.tools,
      permissions: adapter.profile.permissions && reported.profile.permissions,
      mcp: adapter.profile.mcp && reported.profile.mcp,
      subagents: adapter.profile.subagents && reported.profile.subagents,
      resources: {
        files: adapter.profile.resources.files && reported.profile.resources.files,
        instructions:
          adapter.profile.resources.instructions && reported.profile.resources.instructions,
        tools:
          adapter.profile.resources.tools === true && reported.profile.resources.tools === true,
        skills:
          adapter.profile.resources.skills === true && reported.profile.resources.skills === true,
        agents:
          adapter.profile.resources.agents === true && reported.profile.resources.agents === true,
        commands:
          adapter.profile.resources.commands === true && reported.profile.resources.commands === true,
      },
      hooks: adapter.profile.hooks === true && reported.profile.hooks === true,
      modes: adapter.profile.modes === true && reported.profile.modes === true,
      runtimeUpdate: adapter.profile.runtimeUpdate && reported.profile.runtimeUpdate,
      // AgentEnvironmentProvider has no profile validator, even when Bridge does.
      validation: false,
      ...intersectExtensions(adapter.profile.extensions, reported.profile.extensions),
    },
    streaming,
    sessions,
    ...(retainedControl === undefined ? {} : { retainedControl }),
    ...(nativeContinuation === undefined ? {} : { nativeContinuation }),
    ...(interactions === undefined ? {} : { interactions }),
    // Remote workspace support cannot create absent adapter methods.
    workspace: {
      read: false,
      write: false,
      exec: false,
      git: false,
      upload: false,
      download: false,
    },
    branching: { checkpoint: false, fork: false },
    placement: adapter.placement && reported.placement,
    usage: adapter.usage && reported.usage,
    confidential: adapter.confidential && reported.confidential,
    // Observation is measured by this adapter, not by the remote backend document.
    ...(observation === undefined ? {} : { observation }),
  };
  return AgentEnvironmentCapabilitiesSchema.parse(candidate) as AgentEnvironmentCapabilities;
}

function intersectObservation(
  adapter: AgentEnvironmentCapabilities["observation"],
  reported: AgentEnvironmentCapabilities["observation"],
): AgentEnvironmentCapabilities["observation"] {
  if (adapter === undefined || reported === undefined) return undefined;
  return {
    identity: adapter.identity && reported.identity,
    lifecycle: adapter.lifecycle && reported.lifecycle,
    endpoint: adapter.endpoint && reported.endpoint,
    placement: adapter.placement && reported.placement,
    resources: adapter.resources && reported.resources,
    resourceUse: adapter.resourceUse && reported.resourceUse,
    modelUsage: adapter.modelUsage && reported.modelUsage,
    computeBilling: adapter.computeBilling && reported.computeBilling,
    accountUsage: adapter.accountUsage && reported.accountUsage,
  };
}

function supportsRetainedControl(capabilities: AgentEnvironmentCapabilities): boolean {
  const retained = capabilities.retainedControl;
  return Boolean(
    retained?.exactRunIdentity &&
      retained.resultIdentity &&
      retained.eventIdentity &&
      retained.cancellationIdempotency &&
      capabilities.streaming.replay &&
      capabilities.streaming.detach &&
      capabilities.streaming.turnIdempotency &&
      capabilities.sessions.continue,
  );
}

function intersectExtensions(
  adapter: readonly string[] | undefined,
  reported: readonly string[] | undefined,
): { extensions?: string[] } {
  if (adapter === undefined || reported === undefined) return {};
  const allowed = new Set(reported);
  return { extensions: adapter.filter((extension) => allowed.has(extension)) };
}
