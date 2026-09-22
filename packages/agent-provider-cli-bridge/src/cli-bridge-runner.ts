import type {
  AgentEnvironmentEvent,
  AgentSessionRef,
  CreateAgentEnvironmentInput,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  captureCliBridgeRunIdentity,
  cancelCliBridgeRun,
  CliBridgeRequestRejectedError,
  CliBridgeRunIdentityError,
  detachCliBridgeReader,
  getCliBridgeRun,
  readCliBridgeResponseText,
  streamCliBridgeTurn,
} from "./cli-bridge-client.js";
import { CliBridgeProtocolError } from "./cli-bridge-limits.js";
import {
  bindCliBridgeRun,
  bindCliBridgeSession,
  prepareCliBridgeRun,
  restoreCliBridgeRun,
  restoreCliBridgeSession,
  settleCliBridgeSession,
} from "./cli-bridge-runs.js";
import { requestHeaders, trimSlash } from "./cli-bridge-transport.js";
import type {
  CliBridgeProviderOptions,
  CliBridgeRun,
  CliBridgeRunSnapshot,
  CliBridgeSessionState,
  CliBridgeTransport,
  PreparedCliBridgeRun,
} from "./cli-bridge-types.js";

export async function* streamTrackedCliBridgeTurn(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  prepared: PreparedCliBridgeRun,
  transport: CliBridgeTransport,
  runs: Map<string, CliBridgeRun>,
  sessions: Map<string, CliBridgeSessionState>,
  readers: Set<AbortController>,
): AsyncIterable<AgentEnvironmentEvent> {
  const originalTurn = prepared.turn;
  if (originalTurn.detach) {
    throw new Error("cli-bridge provider does not support detached turns");
  }
  const controller = new AbortController();
  const signals = [
    originalTurn.signal,
    environmentInput.signal,
    controller.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const turn = {
    ...originalTurn,
    ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
  };
  const run = prepared.run;
  const previousRun = bindCliBridgeRun(run, runs);
  const previousSessionRun = bindCliBridgeSession(run, sessions);
  run.readers.add(controller);
  readers.add(controller);

  let drained = false;
  let threw = false;
  try {
    for await (const event of streamCliBridgeTurn(
      options,
      turn,
      run.requestBody,
      transport,
      run.id,
      originalTurn.lastEventId,
      signals.length > 0 ? AbortSignal.any(signals) : undefined,
      (response) => {
        captureCliBridgeRunIdentity(response, run);
        run.accepted = true;
      },
    )) {
      yield event;
    }
    drained = true;
    run.settled = true;
    if (runs.get(run.id) === run) runs.delete(run.id);
    settleCliBridgeSession(run, previousSessionRun, sessions);
  } catch (error) {
    threw = true;
    if (error instanceof CliBridgeRunIdentityError) {
      restoreCliBridgeRun(run, previousRun, runs);
      restoreCliBridgeSession(run, previousSessionRun, sessions);
      throw error;
    }
    if (error instanceof CliBridgeProtocolError && run.accepted) {
      try {
        await cancelCliBridgeRun(options, transport, run);
        run.settled = true;
        if (runs.get(run.id) === run) runs.delete(run.id);
        settleCliBridgeSession(run, previousSessionRun, sessions);
      } catch (cancellationError) {
        throw new AggregateError(
          [error, cancellationError],
          "cli-bridge protocol failure cleanup was not confirmed",
        );
      }
      throw error;
    }
    if (error instanceof CliBridgeRequestRejectedError) {
      restoreCliBridgeRun(run, previousRun, runs);
      restoreCliBridgeSession(run, previousSessionRun, sessions);
      throw error;
    }
    let snapshot: CliBridgeRunSnapshot | null | undefined;
    try {
      snapshot = await getCliBridgeRun(options, transport, run.id);
    } catch {
      snapshot = undefined;
    }
    if (snapshot?.terminal) {
      run.settled = true;
      if (runs.get(run.id) === run) runs.delete(run.id);
      settleCliBridgeSession(run, previousSessionRun, sessions);
    } else if (originalTurn.signal?.aborted || environmentInput.signal?.aborted) {
      await cancelCliBridgeRun(options, transport, run);
      run.settled = true;
      if (runs.get(run.id) === run) runs.delete(run.id);
      settleCliBridgeSession(run, previousSessionRun, sessions);
    }
    throw error;
  } finally {
    if (!drained && !threw && runs.get(run.id) === run) {
      await cancelCliBridgeRun(options, transport, run);
      run.settled = true;
      runs.delete(run.id);
      settleCliBridgeSession(run, previousSessionRun, sessions);
    }
    run.readers.delete(controller);
    readers.delete(controller);
  }
}

export async function dispatchCliBridgeTurn(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  prepared: PreparedCliBridgeRun,
  transport: CliBridgeTransport,
  providerName: string,
  runs: Map<string, CliBridgeRun>,
  sessions: Map<string, CliBridgeSessionState>,
): Promise<AgentSessionRef> {
  const run = prepared.run;
  const previousRun = bindCliBridgeRun(run, runs);
  const previousSessionRun = bindCliBridgeSession(run, sessions);
  const signals = [
    prepared.turn.signal,
    environmentInput.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  let accepted = false;
  let responseBody: AsyncIterable<Uint8Array> | undefined;
  try {
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          ...requestHeaders(options, run.sessionId),
          accept: "text/event-stream",
        },
        body: run.requestBody,
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      let detail = "request rejected";
      try {
        detail = await readCliBridgeResponseText(response);
      } catch (readError) {
        if (readError instanceof CliBridgeProtocolError) throw readError;
        // The HTTP status already proves this request was rejected.
      }
      throw new CliBridgeRequestRejectedError(response.status, detail);
    }
    if (response.body) responseBody = response.body;
    captureCliBridgeRunIdentity(response, run);
    accepted = true;
    run.accepted = true;
    if (!response.body) {
      throw new CliBridgeProtocolError("invalid-body", 0, 0);
    }
    await detachCliBridgeReader(response.body);
    responseBody = undefined;
    return {
      id: run.sessionId!,
      provider: providerName,
      metadata: {
        runId: run.id,
        requestDigest: run.requestDigest,
      },
    };
  } catch (error) {
    let failure = error;
    if (responseBody) {
      try {
        await detachCliBridgeReader(responseBody);
      } catch (detachError) {
        failure = new AggregateError(
          [failure, detachError],
          `cli-bridge dispatch "${run.id}" failed and its reader did not detach`,
        );
      }
    }
    if (error instanceof CliBridgeRunIdentityError) {
      restoreCliBridgeRun(run, previousRun, runs);
      restoreCliBridgeSession(run, previousSessionRun, sessions);
      throw failure;
    }
    if (failure instanceof CliBridgeRequestRejectedError) {
      restoreCliBridgeRun(run, previousRun, runs);
      restoreCliBridgeSession(run, previousSessionRun, sessions);
      throw failure;
    }
    if (accepted || signal?.aborted) {
      try {
        await cancelCliBridgeRun(options, transport, run);
        run.settled = true;
        if (runs.get(run.id) === run) runs.delete(run.id);
      } catch (cancellationError) {
        throw new AggregateError(
          [failure, cancellationError],
          `cli-bridge dispatch "${run.id}" failed and cancellation was not confirmed`,
        );
      }
    } else {
      restoreCliBridgeRun(run, previousRun, runs);
    }
    restoreCliBridgeSession(run, previousSessionRun, sessions);
    throw failure;
  }
}

export { prepareCliBridgeRun };
