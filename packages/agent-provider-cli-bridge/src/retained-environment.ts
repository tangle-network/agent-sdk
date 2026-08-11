import type {
  AgentEnvironment,
  AgentEnvironmentEvent,
  AgentSession,
  AgentSessionStatus,
  AgentTurnInput,
  AgentTurnResult,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentRunCancellationAcknowledgement,
  AgentRunControlRef,
} from "@tangle-network/agent-interface";
import {
  agentSessionStatusFromRun,
  cancelCliBridgeRun,
  cancelExactCliBridgeRun,
  getCliBridgeRun,
} from "./retained-control.js";
import {
  collectCliBridgeTurnResult,
  dispatchCliBridgeTurn,
  streamCliBridgeSessionEvents,
  streamTrackedCliBridgeTurn,
} from "./retained-execution.js";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import {
  assertRunMatchesControlRef,
  exactControlRefForSession,
  prepareCliBridgeRun,
  runFromControlRef,
  type CliBridgeRun,
  type CliBridgeSessionState,
} from "./retained-run-state.js";
import { createCliBridgeTransport } from "./transport.js";
import type { CliBridgeTransport } from "./transport.js";

export interface CreateCliBridgeEnvironmentArgs {
  readonly options: CliBridgeProviderOptions;
  readonly providerName: string;
  readonly environmentInput: CreateAgentEnvironmentInput;
  readonly environmentId: string;
  readonly allowDispatch: boolean;
  readonly cancelRunsOnDestroy: boolean;
}

export function createCliBridgeEnvironment(
  args: CreateCliBridgeEnvironmentArgs,
): AgentEnvironment {
  const { options, providerName, environmentInput, environmentId } = args;
  const transport = createCliBridgeTransport(options);
  const runs = new Map<string, CliBridgeRun>();
  const sessions = new Map<string, CliBridgeSessionState>();
  const readers = new Set<AbortController>();
  let destroyed = false;
  let closePromise: Promise<void> | undefined;
  const stream = async function* (
    turn: AgentTurnInput,
  ): AsyncIterable<AgentEnvironmentEvent> {
    if (destroyed) throw new Error("cli-bridge environment is destroyed");
    if (!args.allowDispatch) {
      throw new Error("a reconstructed cli-bridge environment can only control an existing run");
    }
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
  return {
    id: environmentId,
    provider: providerName,
    ...(environmentInput.name ? { name: environmentInput.name } : {}),
    status: async (statusOptions) => {
      statusOptions?.signal?.throwIfAborted();
      return destroyed ? "stopped" : "running";
    },
    stream,
    async dispatch(turn) {
      if (destroyed) throw new Error("cli-bridge environment is destroyed");
      if (!args.allowDispatch) {
        throw new Error("a reconstructed cli-bridge environment cannot dispatch new work");
      }
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
        providerName,
        runs,
        sessions,
      );
    },
    session(id, sessionOptions) {
      sessionOptions?.signal?.throwIfAborted();
      return createCliBridgeSession({
        id,
        providerName,
        options,
        environmentInput,
        environmentId,
        transport,
        runs,
        sessions,
        readers,
        allowPrompt: args.allowDispatch,
        requestedControlRef: sessionOptions?.controlRef,
        isDestroyed: () => destroyed,
      });
    },
    placement: async (placementOptions) => {
      placementOptions?.signal?.throwIfAborted();
      return {
        kind: options.defaultExecution?.kind === "sandbox" ? "sandbox" : "local",
        providerMetadata: { baseUrl: options.baseUrl },
      };
    },
    async destroy(destroyOptions) {
      if (closePromise) return closePromise;
      destroyOptions?.signal?.throwIfAborted();
      destroyed = true;
      let cleanupConfirmed = false;
      const attempt = (async () => {
        if (args.cancelRunsOnDestroy) {
          const cancellations = await Promise.allSettled(
            Array.from(runs.values()).map(async (run) => {
              const snapshot = await cancelCliBridgeRun(
                options,
                transport,
                run,
                destroyOptions?.signal,
              );
              if (runs.get(run.id) === run) runs.delete(run.id);
              return snapshot;
            }),
          );
          const failures = cancellations.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(failures, "cli-bridge environment cancellation failed");
          }
        }
        cleanupConfirmed = true;
        for (const reader of readers) {
          reader.abort(
            new DOMException("cli-bridge environment was destroyed", "AbortError"),
          );
        }
        await transport.close();
        sessions.clear();
        runs.clear();
      })();
      closePromise = attempt;
      try {
        await attempt;
      } catch (error) {
        closePromise = undefined;
        if (!cleanupConfirmed) destroyed = false;
        throw error;
      }
    },
  } satisfies AgentEnvironment;
}

interface CreateCliBridgeSessionArgs {
  readonly id: string;
  readonly providerName: string;
  readonly options: CliBridgeProviderOptions;
  readonly environmentInput: CreateAgentEnvironmentInput;
  readonly environmentId: string;
  readonly transport: CliBridgeTransport;
  readonly runs: Map<string, CliBridgeRun>;
  readonly sessions: Map<string, CliBridgeSessionState>;
  readonly readers: Set<AbortController>;
  readonly allowPrompt: boolean;
  readonly requestedControlRef?: AgentRunControlRef;
  readonly isDestroyed: () => boolean;
}

function createCliBridgeSession(args: CreateCliBridgeSessionArgs): AgentSession {
  const requestedControlRef = args.requestedControlRef === undefined
    ? undefined
    : exactControlRefForSession(
        args.requestedControlRef,
        args.providerName,
        args.environmentId,
        args.id,
      );
  if (requestedControlRef) {
    const current = args.sessions.get(args.id)?.current;
    if (current) {
      assertRunMatchesControlRef(current, requestedControlRef);
      const indexed = args.runs.get(requestedControlRef.runId);
      if (indexed) assertRunMatchesControlRef(indexed, requestedControlRef);
      else args.runs.set(current.id, current);
    } else {
      const existing = args.runs.get(requestedControlRef.runId);
      if (existing) {
        assertRunMatchesControlRef(existing, requestedControlRef);
        args.sessions.set(args.id, { id: args.id, current: existing });
      } else {
        const reconstructed = runFromControlRef(requestedControlRef);
        args.runs.set(reconstructed.id, reconstructed);
        args.sessions.set(args.id, { id: args.id, current: reconstructed });
      }
    }
  }
  const currentRun = (): CliBridgeRun | undefined => {
    if (args.isDestroyed()) throw new Error("cli-bridge environment is destroyed");
    return args.sessions.get(args.id)?.current;
  };
  const requireCurrentRun = (): CliBridgeRun => {
    const run = currentRun();
    if (!run) throw new Error(`cli-bridge session "${args.id}" has no run`);
    return run;
  };

  return {
    id: args.id,
    get controlRef() {
      return currentRun()?.controlRef;
    },
    async status(statusOptions): Promise<AgentSessionStatus | null> {
      const run = currentRun();
      if (!run) return null;
      const snapshot = await getCliBridgeRun(
        args.options,
        args.transport,
        run,
        undefined,
        statusOptions?.signal,
      );
      if (!snapshot) return null;
      return agentSessionStatusFromRun(snapshot);
    },
    async *events(eventOptions): AsyncIterable<AgentEnvironmentEvent> {
      const run = requireCurrentRun();
      yield* streamCliBridgeSessionEvents(
        args.options,
        args.environmentInput,
        run,
        args.transport,
        args.runs,
        args.readers,
        eventOptions,
      );
    },
    async result(resultOptions): Promise<AgentTurnResult> {
      const run = requireCurrentRun();
      return collectCliBridgeTurnResult(
        streamCliBridgeSessionEvents(
          args.options,
          args.environmentInput,
          run,
          args.transport,
          args.runs,
          args.readers,
          { since: "0", signal: resultOptions?.signal },
        ),
        run,
        args.options,
        args.transport,
        resultOptions?.signal,
      );
    },
    async prompt(input: AgentTurnInput): Promise<AgentTurnResult> {
      if (!args.allowPrompt) {
        throw new Error("a reconstructed cli-bridge session cannot start another turn");
      }
      if (input.sessionId && input.sessionId !== args.id) {
        throw new Error(
          `cli-bridge session "${args.id}" cannot prompt session "${input.sessionId}"`,
        );
      }
      const prepared = prepareCliBridgeRun(
        args.options,
        args.environmentInput,
        {
          ...input,
          sessionId: args.id,
        },
        args.environmentId,
        false,
      );
      const result = await collectCliBridgeTurnResult(
        streamTrackedCliBridgeTurn(
          args.options,
          args.environmentInput,
          prepared,
          args.transport,
          args.runs,
          args.sessions,
          args.readers,
        ),
        prepared.run,
        args.options,
        args.transport,
        input.signal,
      );
      return { ...result, sessionId: args.id };
    },
    async cancel(cancelOptions): Promise<void> {
      const run = requireCurrentRun();
      await cancelCliBridgeRun(
        args.options,
        args.transport,
        run,
        cancelOptions?.signal,
      );
    },
    async cancelRun(request, cancelOptions): Promise<AgentRunCancellationAcknowledgement> {
      const run = requireCurrentRun();
      return cancelExactCliBridgeRun(
        args.options,
        args.transport,
        run,
        request,
        cancelOptions?.signal,
      );
    },
  };
}
