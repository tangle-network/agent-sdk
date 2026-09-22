import type {
  AgentEnvironmentEvent,
  AgentSession,
  AgentSessionStatus,
  AgentTurnInput,
  AgentTurnResult,
} from "@tangle-network/agent-interface/environment-provider";
import {
  agentSessionStatusFromRun,
  cancelCliBridgeRun,
  captureCliBridgeRunIdentity,
  getCliBridgeRun,
  streamCliBridgeTurn,
} from "./cli-bridge-client.js";
import {
  CliBridgeProtocolError,
  preserveRootError,
} from "./cli-bridge-limits.js";
import { collectCliBridgeTurnResult } from "./cli-bridge-result-collector.js";
import {
  prepareCliBridgeRun,
  settleCliBridgeSession,
} from "./cli-bridge-runs.js";
import { streamTrackedCliBridgeTurn } from "./cli-bridge-runner.js";
import type {
  CliBridgeEventSourceOptions,
  CliBridgeRun,
  CreateCliBridgeSessionArgs,
} from "./cli-bridge-types.js";

export function createCliBridgeSession(args: CreateCliBridgeSessionArgs): AgentSession {
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
    async status(): Promise<AgentSessionStatus | null> {
      const run = currentRun();
      if (!run) return null;
      const snapshot = await getCliBridgeRun(args.options, args.transport, run.id);
      if (!snapshot) return null;
      if (snapshot.terminal) {
        run.settled = true;
        if (args.runs.get(run.id) === run) args.runs.delete(run.id);
        settleCliBridgeSession(run, run.sessionPrevious, args.sessions);
      }
      return agentSessionStatusFromRun(snapshot);
    },
    async *events(options): AsyncIterable<AgentEnvironmentEvent> {
      const run = requireCurrentRun();
      yield* streamCliBridgeSessionEvents(
        args.options,
        args.environmentInput,
        run,
        args.transport,
        args.runs,
        args.sessions,
        args.readers,
        options,
      );
    },
    async result(): Promise<AgentTurnResult> {
      const run = requireCurrentRun();
      return collectCliBridgeTurnResult(
        streamCliBridgeSessionEvents(
          args.options,
          args.environmentInput,
          run,
          args.transport,
          args.runs,
          args.sessions,
          args.readers,
          { since: "0" },
        ),
        run,
        args.options,
        args.transport,
        args.runs,
        args.sessions,
      );
    },
    async prompt(input: AgentTurnInput): Promise<AgentTurnResult> {
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
        args.runs,
        args.sessions,
      );
      return { ...result, sessionId: args.id };
    },
    async cancel(): Promise<void> {
      const run = requireCurrentRun();
      await cancelCliBridgeRun(args.options, args.transport, run);
      run.settled = true;
      if (args.runs.get(run.id) === run) args.runs.delete(run.id);
      settleCliBridgeSession(run, run.sessionPrevious, args.sessions);
    },
  };
}

async function* streamCliBridgeSessionEvents(
  options: CreateCliBridgeSessionArgs["options"],
  environmentInput: CreateCliBridgeSessionArgs["environmentInput"],
  run: CliBridgeRun,
  transport: CreateCliBridgeSessionArgs["transport"],
  runs: CreateCliBridgeSessionArgs["runs"],
  sessions: CreateCliBridgeSessionArgs["sessions"],
  readers: CreateCliBridgeSessionArgs["readers"],
  eventOptions?: CliBridgeEventSourceOptions,
): AsyncIterable<AgentEnvironmentEvent> {
  const controller = new AbortController();
  const signals = [
    eventOptions?.signal,
    environmentInput.signal,
    controller.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  run.readers.add(controller);
  readers.add(controller);
  let drained = false;
  let rootError: unknown;
  try {
    yield* streamCliBridgeTurn(
      options,
      {
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        turnId: run.turnId,
      },
      run.requestBody,
      transport,
      run.id,
      eventOptions?.since ?? "0",
      signal,
      (response) => {
        captureCliBridgeRunIdentity(response, run);
        run.accepted = true;
      },
    );
    drained = true;
    run.settled = true;
    if (runs.get(run.id) === run) runs.delete(run.id);
    settleCliBridgeSession(run, run.sessionPrevious, sessions);
  } catch (error) {
    rootError = error;
    if (error instanceof CliBridgeProtocolError && run.accepted) {
      try {
        await cancelCliBridgeRun(options, transport, run);
        run.settled = true;
        if (runs.get(run.id) === run) runs.delete(run.id);
        settleCliBridgeSession(run, run.sessionPrevious, sessions);
      } catch (cancellationError) {
        throw new AggregateError(
          [error, cancellationError],
          "cli-bridge protocol failure cleanup was not confirmed",
        );
      }
    }
    throw error;
  } finally {
    if (!drained) {
      try {
        controller.abort(
          new DOMException(
            "cli-bridge session event reader detached",
            "AbortError",
          ),
        );
      } catch (abortError) {
        if (rootError !== undefined) {
          throw preserveRootError(
            rootError,
            abortError,
            "cli-bridge session reader cleanup failed",
          );
        }
        throw abortError;
      }
    }
    run.readers.delete(controller);
    readers.delete(controller);
  }
}

export { collectCliBridgeTurnResult } from "./cli-bridge-result-collector.js";

