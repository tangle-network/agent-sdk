import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentSession,
  AgentSessionRef,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import { snapshotAgentProfile } from "@tangle-network/agent-interface";
import { cancelCliBridgeRun } from "./cli-bridge-client.js";
import { createCliBridgeSession } from "./cli-bridge-session.js";
import { prepareCliBridgeRun } from "./cli-bridge-runs.js";
import {
  dispatchCliBridgeTurn,
  streamTrackedCliBridgeTurn,
} from "./cli-bridge-runner.js";
import { createTransport } from "./cli-bridge-transport.js";
import type {
  CliBridgeProviderOptions,
  CliBridgeRun,
  CliBridgeSessionState,
} from "./cli-bridge-types.js";

export type { CliBridgeProviderOptions } from "./cli-bridge-types.js";

export function createCliBridgeProvider(
  options: CliBridgeProviderOptions,
): AgentEnvironmentProvider {
  assertTimeout(options.headersTimeoutMs, "headersTimeoutMs");
  assertTimeout(options.bodyTimeoutMs, "bodyTimeoutMs");
  assertTimeout(options.cancelWaitMs, "cancelWaitMs");
  const name = options.name ?? "cli-bridge";
  return {
    name,
    capabilities: () => options.capabilities ?? defaultCliBridgeCapabilities(),
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
      const transport = createTransport(options);
      const environmentId = input.idempotencyKey ?? crypto.randomUUID();
      const runs = new Map<string, CliBridgeRun>();
      const sessions = new Map<string, CliBridgeSessionState>();
      const readers = new Set<AbortController>();
      let destroyed = false;
      let closePromise: Promise<void> | undefined;
      const stream = async function* (
        turn: AgentTurnInput,
      ): AsyncIterable<AgentEnvironmentEvent> {
        if (destroyed) throw new Error("cli-bridge environment is destroyed");
        const prepared = prepareCliBridgeRun(
          options,
          environmentInput,
          turn,
          environmentId,
          false,
        );
        yield* streamTrackedCliBridgeTurn(
          options,
          environmentInput,
          prepared,
          transport,
          runs,
          sessions,
          readers,
        );
      };
      const environment = {
        id: environmentId,
        provider: name,
        ...(input.name ? { name: input.name } : {}),
        status: async () => (destroyed ? "stopped" : "running"),
        stream,
        async dispatch(turn: AgentTurnInput): Promise<AgentSessionRef> {
          if (destroyed) throw new Error("cli-bridge environment is destroyed");
          const prepared = prepareCliBridgeRun(
            options,
            environmentInput,
            turn,
            environmentId,
            true,
          );
          return dispatchCliBridgeTurn(
            options,
            environmentInput,
            prepared,
            transport,
            name,
            runs,
            sessions,
          );
        },
        session(id: string): AgentSession {
          return createCliBridgeSession({
            id,
            providerName: name,
            options,
            environmentInput,
            environmentId,
            transport,
            runs,
            sessions,
            readers,
            isDestroyed: () => destroyed,
          });
        },
        placement: async () => ({
          kind: options.defaultExecution?.kind === "sandbox" ? "sandbox" : "local",
          providerMetadata: { baseUrl: options.baseUrl },
        }),
        async destroy() {
          if (closePromise) return closePromise;
          destroyed = true;
          let cancellationsConfirmed = false;
          const attempt = (async () => {
            const cancellations = await Promise.allSettled(
              Array.from(runs.values()).map(async (run) => {
                const snapshot = await cancelCliBridgeRun(options, transport, run);
                if (runs.get(run.id) === run) runs.delete(run.id);
                return snapshot;
              }),
            );
            const failures = cancellations.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
              throw new AggregateError(
                failures,
                "cli-bridge environment cancellation failed",
              );
            }
            cancellationsConfirmed = true;
            for (const reader of readers) {
              reader.abort(
                new DOMException("cli-bridge environment was destroyed", "AbortError"),
              );
            }
            await transport.close();
            sessions.clear();
          })();
          closePromise = attempt;
          try {
            await attempt;
          } catch (error) {
            closePromise = undefined;
            if (!cancellationsConfirmed) destroyed = false;
            throw error;
          }
        },
      } satisfies AgentEnvironment;
      return environment;
    },
  };
}

function assertTimeout(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`createCliBridgeProvider ${name} must be a non-negative integer`);
  }
}

export function defaultCliBridgeCapabilities(): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: false,
      systemPrompt: true,
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
  };
}
