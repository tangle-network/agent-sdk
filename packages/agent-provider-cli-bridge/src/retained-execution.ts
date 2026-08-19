import type { StreamEvent, TokenUsage } from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentEvent,
  AgentSessionRef,
  AgentTurnResult,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  cancelCliBridgeRun,
  captureCliBridgeRunIdentity,
  cliBridgeCancellationSignal,
  detachCliBridgeReader,
  getCliBridgeRun,
} from "./retained-control.js";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import {
  bindCliBridgeRun,
  bindCliBridgeSession,
  exactControlRefForRun,
  restoreCliBridgeRun,
  restoreCliBridgeSession,
  type CliBridgeRun,
  type CliBridgeRunSnapshot,
  type CliBridgeSessionState,
  type PreparedCliBridgeRun,
} from "./retained-run-state.js";
import {
  CliBridgeRequestRejectedError,
  streamCliBridgeTurn,
} from "./retained-stream.js";
import {
  beginCliBridgeNativeTurn,
  type CliBridgeNativeSessionCache,
} from "./retained-native.js";
import type { CliBridgeTransport } from "./transport.js";
import {
  MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
  readBoundedCliBridgeResponse,
  requestHeaders,
  trimSlash,
} from "./transport.js";
import { modelRequestCount } from "./wire.js";

export async function* streamTrackedCliBridgeTurn(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  providerName: string,
  prepared: PreparedCliBridgeRun,
  transport: CliBridgeTransport,
  runs: Map<string, CliBridgeRun>,
  sessions: Map<string, CliBridgeSessionState>,
  readers: Set<AbortController>,
  nativeSessions: CliBridgeNativeSessionCache,
  useNativeInteractions: boolean,
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
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  const turn = {
    ...originalTurn,
    ...(signal ? { signal } : {}),
  };
  const run = prepared.run;
  const previousRun = bindCliBridgeRun(run, runs);
  const previousSessionRun = bindCliBridgeSession(run, sessions);
  run.readers.add(controller);
  readers.add(controller);

  let drained = false;
  let threw = false;
  let admitted = false;
  let admissionValidated = false;
  try {
    if (useNativeInteractions) {
      await beginCliBridgeNativeTurn(
        options,
        providerName,
        environmentInput,
        turn,
        run,
        transport,
        nativeSessions,
        signal,
        () => {
          admitted = true;
        },
      );
      admissionValidated = true;
      for await (const event of streamCliBridgeTurn(
        options,
        turn,
        undefined,
        transport,
        run.id,
        originalTurn.lastEventId,
        signal,
        (response) => captureCliBridgeRunIdentity(response, run, false),
        () => getCliBridgeRun(options, transport, run, 30_000, signal),
        (event) => assertCanonicalEventBinding(event.normalized, run, providerName),
      )) {
        yield event;
      }
    } else {
      for await (const event of streamCliBridgeTurn(
        options,
        turn,
        run.requestBody,
        transport,
        run.id,
        originalTurn.lastEventId,
        signal,
        (response) => {
          admitted = true;
          captureCliBridgeRunIdentity(response, run, true);
          admissionValidated = response.body !== null;
        },
        () => getCliBridgeRun(options, transport, run, 30_000, signal),
      )) {
        yield event;
      }
    }
    drained = true;
    if (runs.get(run.id) === run) runs.delete(run.id);
  } catch (error) {
    threw = true;
    if (error instanceof CliBridgeRequestRejectedError && !admitted) {
      restoreCliBridgeRun(run, previousRun, runs);
      restoreCliBridgeSession(run, previousSessionRun, sessions);
      throw error;
    }
    let snapshot: CliBridgeRunSnapshot | null | undefined;
    try {
      snapshot = await getCliBridgeRun(
        options,
        transport,
        run,
        undefined,
        cliBridgeCancellationSignal(options),
      );
    } catch {
      snapshot = undefined;
    }
    if (snapshot?.terminal) {
      if (runs.get(run.id) === run) runs.delete(run.id);
    } else if (
      (admitted && !admissionValidated) ||
      originalTurn.signal?.aborted ||
      environmentInput.signal?.aborted
    ) {
      try {
        const cancellation = await cancelCliBridgeRun(options, transport, run);
        if (cancellation.requestDigest !== undefined) {
          run.requestDigest = cancellation.requestDigest;
        }
        if (runs.get(run.id) === run) runs.delete(run.id);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `cli-bridge stream "${run.id}" failed and exact cancellation was not confirmed`,
        );
      }
    }
    throw error;
  } finally {
    if (!drained && !threw && runs.get(run.id) === run) {
      await cancelCliBridgeRun(options, transport, run);
      runs.delete(run.id);
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
  nativeSessions: CliBridgeNativeSessionCache,
  useNativeInteractions: boolean,
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
    if (useNativeInteractions) {
      await beginCliBridgeNativeTurn(
        options,
        providerName,
        environmentInput,
        prepared.turn,
        run,
        transport,
        nativeSessions,
        signal,
        () => {
          accepted = true;
        },
      );
    } else {
      const response = await transport.fetch(
        `${trimSlash(options.baseUrl)}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            ...requestHeaders(options),
            accept: "text/event-stream",
            ...(run.sessionId ? { "x-session-id": run.sessionId } : {}),
          },
          body: run.requestBody,
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) {
        let detail = "request rejected";
        try {
          detail = await readBoundedCliBridgeResponse(
            response,
            MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
            signal,
          );
        } catch {
          // The HTTP status already proves this request was rejected.
        }
        throw new CliBridgeRequestRejectedError(response.status, detail);
      }
      accepted = true;
      if (!response.body) throw new Error("cli-bridge response body is empty");
      responseBody = response.body;
      captureCliBridgeRunIdentity(response, run, true);
    }
    const controlRef = exactControlRefForRun(run, providerName);
    run.controlRef = controlRef;
    if (responseBody) {
      await detachCliBridgeReader(responseBody);
      responseBody = undefined;
    }
    return {
      id: run.sessionId!,
      provider: providerName,
      controlRef,
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
    if (failure instanceof CliBridgeRequestRejectedError) {
      restoreCliBridgeRun(run, previousRun, runs);
      restoreCliBridgeSession(run, previousSessionRun, sessions);
      throw failure;
    }
    if (accepted || signal?.aborted) {
      try {
        await cancelCliBridgeRun(options, transport, run);
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

export async function* streamCliBridgeSessionEvents(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  providerName: string,
  run: CliBridgeRun,
  transport: CliBridgeTransport,
  runs: Map<string, CliBridgeRun>,
  readers: Set<AbortController>,
  eventOptions?: { since?: string; executionId?: string; signal?: AbortSignal },
): AsyncIterable<AgentEnvironmentEvent> {
  if (
    eventOptions?.executionId !== undefined &&
    eventOptions.executionId !== run.executionId
  ) {
    throw new Error("cli-bridge event request targets another retained execution");
  }
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
  try {
    yield* streamCliBridgeTurn(
      options,
      {
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        executionId: run.executionId,
        turnId: run.turnId,
      },
      undefined,
      transport,
      run.id,
      eventOptions?.since ?? "0",
      signal,
      (response) => captureCliBridgeRunIdentity(response, run, false),
      () => getCliBridgeRun(options, transport, run, 30_000, signal),
      (event) => assertCanonicalEventBinding(event.normalized, run, providerName),
    );
    drained = true;
    if (runs.get(run.id) === run) runs.delete(run.id);
  } finally {
    if (!drained) {
      controller.abort(
        new DOMException("cli-bridge session event reader detached", "AbortError"),
      );
    }
    run.readers.delete(controller);
    readers.delete(controller);
  }
}

function assertCanonicalEventBinding(
  event: StreamEvent | undefined,
  run: CliBridgeRun,
  providerName: string,
): void {
  if (event?.type !== "interaction") return;
  const binding = event.request.binding;
  if (
    binding.runId !== run.id ||
    binding.provider !== providerName ||
    binding.environmentId !== run.environmentId ||
    binding.sessionId !== run.sessionId ||
    binding.executionId !== run.executionId ||
    binding.interactionId !== event.request.id
  ) {
    throw new Error("cli-bridge interaction event does not bind to the retained run");
  }
}

export async function collectCliBridgeTurnResult(
  source: AsyncIterable<AgentEnvironmentEvent>,
  run: CliBridgeRun,
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  signal?: AbortSignal,
): Promise<AgentTurnResult> {
  const events: AgentEnvironmentEvent[] = [];
  let text = "";
  let usage: TokenUsage | undefined;
  let observedModelRequests = 0;
  let modelRequestsKnown = false;
  let terminalModelRequests: number | undefined;
  let servedModel: string | undefined;
  let systemFingerprint: string | undefined;
  let streamError: unknown;
  try {
    for await (const event of source) {
      events.push(event);
      const finalText = event.data.finalText;
      if (typeof finalText === "string") {
        text = finalText;
      } else if (typeof event.data.delta === "string") {
        text += event.data.delta;
      }
      usage = addTokenUsage(usage, event.usage);
      const eventModel = event.data.model;
      const eventFingerprint = event.data.system_fingerprint;
      if (typeof eventModel === "string" && eventModel.length > 0) servedModel = eventModel;
      if (typeof eventFingerprint === "string" && eventFingerprint.length > 0) {
        systemFingerprint = eventFingerprint;
      }
      const modelRequests = modelRequestCount(event.data.modelRequests);
      if (modelRequests !== undefined) {
        if (event.type === "result") {
          terminalModelRequests = modelRequests;
        } else if (event.type === "usage") {
          observedModelRequests += modelRequests;
          modelRequestsKnown = true;
        }
      }
    }
  } catch (error) {
    streamError = error;
  }

  const snapshot = await getCliBridgeRun(options, transport, run, undefined, signal);
  if (!snapshot) {
    if (streamError) throw streamError;
    throw new Error(`cli-bridge lost run "${run.id}" before reading its result`);
  }
  if (!snapshot.terminal) {
    if (streamError) throw streamError;
    throw new Error(`cli-bridge run "${run.id}" has no terminal result`);
  }
  const success = snapshot.status === "done" && streamError === undefined;
  return {
    text,
    success,
    ...(!success
      ? {
          error: streamError instanceof Error
            ? streamError.message
            : `cli-bridge run ended ${snapshot.status}`,
        }
      : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(usage ? { usage } : {}),
    metadata: {
      runId: run.id,
      executionId: run.executionId,
      status: snapshot.status,
      ...(run.requestDigest ? { requestDigest: run.requestDigest } : {}),
      ...(terminalModelRequests !== undefined
        ? { modelRequests: terminalModelRequests }
        : modelRequestsKnown
          ? { modelRequests: observedModelRequests }
          : {}),
      ...(servedModel === undefined ? {} : { model: servedModel }),
      ...(systemFingerprint === undefined ? {} : { system_fingerprint: systemFingerprint }),
    },
    events,
  };
}

/** Sum the usage a run reported across its events into one total. */
export function addTokenUsage(
  current: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!next) return current;
  if (!current) return { ...next };
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(current.totalTokens !== undefined || next.totalTokens !== undefined
      ? { totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0) }
      : {}),
    ...(current.cacheReadInputTokens !== undefined ||
        next.cacheReadInputTokens !== undefined
      ? {
          cacheReadInputTokens:
            (current.cacheReadInputTokens ?? 0) +
            (next.cacheReadInputTokens ?? 0),
        }
      : {}),
    ...(current.cacheCreationInputTokens !== undefined ||
        next.cacheCreationInputTokens !== undefined
      ? {
          cacheCreationInputTokens:
            (current.cacheCreationInputTokens ?? 0) +
            (next.cacheCreationInputTokens ?? 0),
        }
      : {}),
    ...(current.reasoningTokens !== undefined || next.reasoningTokens !== undefined
      ? {
          reasoningTokens:
            (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
        }
      : {}),
    ...(current.cost !== undefined || next.cost !== undefined
      ? { cost: (current.cost ?? 0) + (next.cost ?? 0) }
      : {}),
  };
}
