import {
  AgentEnvironmentCapabilitiesSchema,
  type AgentEnvironmentCapabilities,
} from "@tangle-network/agent-interface/environment-provider";
import type { CliBridgeProviderOptions } from "./provider-options.js";
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
