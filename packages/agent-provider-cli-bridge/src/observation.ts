import { AgentEnvironmentObservationSchema } from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentCapabilities,
  AgentEnvironmentObservation,
  Observation,
  ObservationProvenance,
  ProviderIdentity,
  SafeEndpoint,
  TokenUsage,
} from "@tangle-network/agent-interface";
import type { CliBridgeProviderOptions } from "./provider-options.js";

/** One execution's accumulated token usage and cost. */
interface ExecutionUsageRecord {
  executionId: string;
  usage: TokenUsage;
  observedAt: string;
}

/**
 * The newest per-execution usage this environment handle measured.
 *
 * cli-bridge reports usage on the events of one run, so the totals are summed
 * per execution and the newest execution answers the environment-scoped
 * observation. The record lives with the handle: an environment rebuilt by id
 * starts with none, and the observation then reports the usage surface as
 * unavailable rather than as a measured zero.
 */
export interface ExecutionUsageLog {
  record(executionId: string | undefined, usage: TokenUsage | undefined): void;
  latest(): ExecutionUsageRecord | undefined;
}

export function createExecutionUsageLog(): ExecutionUsageLog {
  let latest: ExecutionUsageRecord | undefined;
  return {
    record(executionId, usage) {
      // Usage without the execution it belongs to cannot be attributed, and an
      // execution without usage measured nothing. Neither is recorded.
      if (executionId === undefined || executionId.length === 0) return;
      if (usage === undefined) return;
      latest = {
        executionId,
        usage,
        observedAt: new Date().toISOString(),
      };
    },
    latest() {
      return latest === undefined
        ? undefined
        : { ...latest, usage: { ...latest.usage } };
    },
  };
}

/**
 * Read the credential-free network location of the cli-bridge endpoint.
 *
 * Only the scheme, host, and explicit port are carried. Userinfo, path, and
 * query are dropped, and the bearer beside the base URL is never read, so an
 * endpoint payload cannot transport a credential.
 */
export function safeEndpointFromBaseUrl(
  baseUrl: string | undefined,
): SafeEndpoint | undefined {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  const host = parsed.hostname;
  if (scheme.length === 0 || host.length === 0) return undefined;
  const port = parsed.port === "" ? undefined : Number.parseInt(parsed.port, 10);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    return undefined;
  }
  return { scheme, host, ...(port === undefined ? {} : { port }) };
}

/**
 * Clear every observation surface no source backs.
 *
 * cli-bridge forwards a turn to a remote bridge and reports what that turn
 * cost. It never provisions compute, so it states no compute shape, no
 * resource use, no compute cost, and no account plan. The endpoint rests on a
 * base URL that parses.
 */
export function narrowedCliBridgeObservation(
  declared: NonNullable<AgentEnvironmentCapabilities["observation"]>,
  options: CliBridgeProviderOptions,
): NonNullable<AgentEnvironmentCapabilities["observation"]> {
  const endpoint = safeEndpointFromBaseUrl(options.baseUrl) !== undefined;
  return {
    identity: declared.identity,
    lifecycle: declared.lifecycle,
    endpoint: endpoint ? declared.endpoint : false,
    placement: declared.placement,
    resources: false,
    resourceUse: false,
    modelUsage: declared.modelUsage,
    computeBilling: false,
    accountUsage: false,
  };
}

export interface CliBridgeObservationSources {
  options: CliBridgeProviderOptions;
  provider: string;
  environmentId: string;
  destroyed: boolean;
  usageLog: ExecutionUsageLog;
}

/** Build the normalized, freshness-tagged observation of one environment. */
export function observeCliBridgeEnvironment(
  sources: CliBridgeObservationSources,
): AgentEnvironmentObservation {
  const capturedAt = new Date().toISOString();
  const provenance: ObservationProvenance = {
    origin: "reported",
    observedAt: capturedAt,
    source: "cli-bridge",
  };
  const subject: ProviderIdentity = {
    provider: sources.provider,
    environmentId: sources.environmentId,
  };
  const endpoint = safeEndpointFromBaseUrl(sources.options.baseUrl);
  const latest = sources.usageLog.latest();
  const absent = (reason: string): Observation<never> => ({
    state: "unavailable",
    reason,
  });
  const noCompute = "cli-bridge forwards a turn and provisions no compute";
  const noAccount = "cli-bridge reports no account plan, credit, or quota";
  return AgentEnvironmentObservationSchema.parse({
    subject,
    capturedAt,
    identity: { state: "known", value: subject, provenance },
    lifecycle: {
      state: "known",
      value: { status: sources.destroyed ? "stopped" : "running" },
      provenance,
    },
    endpoint:
      endpoint === undefined
        ? absent("the cli-bridge base URL states no reachable host")
        : { state: "known", value: endpoint, provenance },
    placement: {
      verified: {
        state: "known",
        value: {
          kind: sources.options.defaultExecution?.kind === "sandbox" ? "sandbox" : "local",
        },
        provenance,
      },
    },
    resources: { effective: absent(noCompute) },
    resourceUse: { current: absent(noCompute), peak: absent(noCompute) },
    modelUsage:
      latest === undefined
        ? absent("no execution measured token usage through this environment handle")
        : {
            state: "known",
            value: latest.usage,
            // The provenance source names the execution the usage belongs to,
            // because cli-bridge measures usage per run and never for the
            // environment.
            provenance: {
              origin: "reported",
              observedAt: latest.observedAt,
              source: latest.executionId,
            },
          },
    computeBilling: absent(noCompute),
    accountUsage: {
      plan: absent(noAccount),
      credits: absent(noAccount),
      quota: absent(noAccount),
      period: absent(noAccount),
    },
  });
}
