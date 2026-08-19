import {
  AgentExactRunControlRefSchema,
  AgentRunCancellationAcknowledgementSchema,
  AgentRunCancellationRequestSchema,
  agentRunCancellationRequestDigest,
  agentRunCancellationAcknowledgementMatchesRequest,
  type AgentExactRunControlRef,
  type AgentRunCancellationAcknowledgement,
  type AgentRunCancellationRequest,
} from "@tangle-network/agent-interface";
import type { AgentSessionStatus } from "@tangle-network/agent-interface/environment-provider";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import type { CliBridgeRun, CliBridgeRunSnapshot } from "./retained-run-state.js";
import type { CliBridgeResponse, CliBridgeTransport } from "./transport.js";
import {
  createCliBridgeTransport,
  MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
  readBoundedCliBridgeResponse,
  requestHeaders,
  trimSlash,
} from "./transport.js";
import { assertCliBridgeRunId, runSnapshot } from "./wire.js";

const DEFAULT_CANCELLATION_WAIT_MS = 30_000;

export function cliBridgeCancellationSignal(
  options: CliBridgeProviderOptions,
): AbortSignal {
  return AbortSignal.timeout(
    options.cancelWaitMs ?? DEFAULT_CANCELLATION_WAIT_MS,
  );
}

export function captureCliBridgeRunIdentity(
  response: CliBridgeResponse,
  run: CliBridgeRun,
  required: boolean,
): void {
  const responseRunId = response.headers.get("x-run-id");
  const requestDigestHeader = response.headers.get("x-run-request-digest");
  const requestDigest = requestDigestHeader === null
    ? null
    : AgentExactRunControlRefSchema.shape.requestDigest.parse(requestDigestHeader);
  if (responseRunId !== null && responseRunId !== run.id) {
    throw new Error(
      `cli-bridge accepted run "${responseRunId}" for requested run "${run.id}"`,
    );
  }
  if ((required || run.requestDigest !== undefined) && responseRunId === null) {
    throw new Error("cli-bridge response omitted X-Run-Id");
  }
  if (required && requestDigest === null) {
    throw new Error("cli-bridge dispatch response omitted X-Run-Request-Digest");
  }
  if (
    requestDigest !== null &&
    run.requestDigest !== undefined &&
    requestDigest !== run.requestDigest
  ) {
    throw new Error(
      `cli-bridge changed request digest for run "${run.id}" from "${run.requestDigest}" to "${requestDigest}"`,
    );
  }
  if (run.requestDigest !== undefined && requestDigest === null) {
    throw new Error(
      `cli-bridge replay response omitted X-Run-Request-Digest for run "${run.id}"`,
    );
  }
  const responseProvider = response.headers.get("x-run-provider");
  const responseEnvironmentId = response.headers.get("x-run-environment-id");
  const responseSessionId = response.headers.get("x-run-session-id");
  const responseExecutionId = response.headers.get("x-run-execution-id");
  const completeCoordinates = [
    responseRunId,
    requestDigest,
    responseProvider,
    responseEnvironmentId,
    responseSessionId,
    responseExecutionId,
  ].every((value) => value !== null);
  if ((required || run.controlRef !== undefined) && !completeCoordinates) {
    throw new Error("cli-bridge response omitted exact run coordinates");
  }
  if (completeCoordinates) {
    bindExactControlRef(
      run,
      AgentExactRunControlRefSchema.parse({
        runId: responseRunId,
        requestDigest,
        provider: responseProvider,
        environmentId: responseEnvironmentId,
        sessionId: responseSessionId,
        executionId: responseExecutionId,
      }),
    );
  } else if (requestDigest !== null) {
    run.requestDigest = requestDigest;
  }
}

export async function detachCliBridgeReader(
  body: AsyncIterable<Uint8Array>,
): Promise<void> {
  const cancellable = body as AsyncIterable<Uint8Array> & {
    cancel?: () => Promise<void>;
  };
  if (cancellable.cancel) {
    await cancellable.cancel();
    return;
  }
  const iterator = body[Symbol.asyncIterator]();
  if (!iterator.return) {
    throw new Error("cli-bridge response body cannot detach its reader");
  }
  await iterator.return();
}

export async function cancelCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
  signal?: AbortSignal,
): Promise<CliBridgeRunSnapshot> {
  if (!run.cancellation) {
    const cancellation = performCliBridgeCancellation(options, transport, run);
    run.cancellation = cancellation;
    void cancellation.then(
      () => clearCancellation(run, cancellation),
      () => clearCancellation(run, cancellation),
    );
  }
  return waitForOperation(run.cancellation, signal);
}

async function performCliBridgeCancellation(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
): Promise<CliBridgeRunSnapshot> {
  const waitBudgetMs = options.cancelWaitMs ?? DEFAULT_CANCELLATION_WAIT_MS;
  const deadline = Date.now() + waitBudgetMs;
  const signal = cliBridgeCancellationSignal(options);
  let snapshot: CliBridgeRunSnapshot | null = null;
  if (run.controlRef === undefined) {
    snapshot = await getCliBridgeRun(options, transport, run, undefined, signal);
    if (snapshot === null) {
      throw new Error(
        `cli-bridge cannot safely cancel unknown run "${run.id}"`,
      );
    }
    if (snapshot.terminal) return snapshot;
  }
  const exactRequest = automaticCancellationRequest(run);
  const response = await waitForOperation(transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(run.id)}/cancel`,
    {
      method: "POST",
      headers: requestHeaders(options),
      body: JSON.stringify(exactRequest),
      signal,
    },
  ), signal);
  const responseText = await waitForOperation(
    readBoundedCliBridgeResponse(response, MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES),
    signal,
  );
  const acknowledgement = parseExactCancellationAcknowledgement(
    exactRequest,
    response.status,
    responseText,
  );
  if (
    acknowledgement.status === "conflict" ||
    acknowledgement.status === "unknown" ||
    acknowledgement.effect === "unknown"
  ) {
    throw new Error(
      `cli-bridge did not prove cancellation for run "${run.id}": ${acknowledgement.status}`,
    );
  }
  if (acknowledgement.effect === "cancelled") {
    snapshot = exactTerminalCancellationSnapshot(run, "cancelled");
  } else if (acknowledgement.effect === "not_live") {
    snapshot = exactTerminalCancellationSnapshot(run, "unknown");
  }
  while (snapshot === null || !snapshot.terminal) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    snapshot = await getCliBridgeRun(
      options,
      transport,
      run,
      Math.min(remainingMs, 30_000),
      signal,
    );
    if (snapshot === null) {
      throw new Error(`cli-bridge lost run "${run.id}" before confirming cancellation`);
    }
  }
  if (!snapshot?.terminal) {
    throw new Error(`cli-bridge run "${run.id}" did not confirm terminal cancellation`);
  }
  for (const reader of run.readers) {
    reader.abort(
      new DOMException(`cli-bridge run ended ${snapshot.status}`, "AbortError"),
    );
  }
  return snapshot;
}

function exactTerminalCancellationSnapshot(
  run: CliBridgeRun,
  status: "cancelled" | "unknown",
): CliBridgeRunSnapshot {
  if (run.controlRef === undefined) {
    throw new Error("cli-bridge exact cancellation lost its bound run identity");
  }
  return {
    id: run.id,
    requestDigest: run.controlRef.requestDigest,
    controlRef: run.controlRef,
    status,
    terminal: true,
  };
}

function automaticCancellationRequest(run: CliBridgeRun): AgentRunCancellationRequest {
  if (run.controlRef === undefined) {
    throw new Error(
      `cli-bridge cannot safely cancel run "${run.id}" without complete exact coordinates`,
    );
  }
  const material = {
    operationId: `cancel-${run.controlRef.requestDigest.slice("sha256:".length)}`,
    run: run.controlRef,
    reason: "provider cleanup",
  };
  return AgentRunCancellationRequestSchema.parse({
    ...material,
    requestDigest: agentRunCancellationRequestDigest(material),
  });
}

function clearCancellation(
  run: CliBridgeRun,
  cancellation: Promise<CliBridgeRunSnapshot>,
): void {
  if (run.cancellation === cancellation) run.cancellation = undefined;
}

function waitForOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function cancelExactCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
  request: AgentRunCancellationRequest,
  signal?: AbortSignal,
): Promise<AgentRunCancellationAcknowledgement> {
  const exactRequest = AgentRunCancellationRequestSchema.parse(request);
  if (!run.controlRef || !sameControlRef(run.controlRef, exactRequest.run)) {
    throw new Error("cli-bridge cancellation targets another retained run");
  }
  const timeoutSignal = cliBridgeCancellationSignal(options);
  const operationSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal]);
  const response = await waitForOperation(transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(run.id)}/cancel`,
    {
      method: "POST",
      headers: requestHeaders(options),
      body: JSON.stringify(exactRequest),
      signal: operationSignal,
    },
  ), operationSignal);
  const responseText = await waitForOperation(
    readBoundedCliBridgeResponse(response, MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES),
    operationSignal,
  );
  return parseExactCancellationAcknowledgement(
    exactRequest,
    response.status,
    responseText,
  );
}

function parseExactCancellationAcknowledgement(
  request: AgentRunCancellationRequest,
  status: number,
  responseText: string,
): AgentRunCancellationAcknowledgement {
  if ((status < 200 || status >= 300) && status !== 409) {
    throw new Error(`cli-bridge cancel ${status}: ${responseText}`);
  }
  let acknowledgement: AgentRunCancellationAcknowledgement;
  try {
    acknowledgement = AgentRunCancellationAcknowledgementSchema.parse(
      JSON.parse(responseText),
    );
  } catch (error) {
    throw new Error("cli-bridge returned an invalid exact cancellation acknowledgement", {
      cause: error,
    });
  }
  if (!agentRunCancellationAcknowledgementMatchesRequest(request, acknowledgement)) {
    throw new Error("cli-bridge returned a cancellation acknowledgement for another request");
  }
  return acknowledgement;
}

function sameControlRef(
  left: AgentExactRunControlRef,
  right: AgentExactRunControlRef,
): boolean {
  return left.runId === right.runId &&
    left.provider === right.provider &&
    left.environmentId === right.environmentId &&
    left.sessionId === right.sessionId &&
    left.executionId === right.executionId &&
    left.requestDigest === right.requestDigest;
}

export async function getCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
  waitMs?: number,
  signal?: AbortSignal,
): Promise<CliBridgeRunSnapshot | null> {
  const query = waitMs === undefined ? "" : `?wait_ms=${waitMs}`;
  const response = await waitForOperation(transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(run.id)}${query}`,
    {
      method: "GET",
      headers: requestHeaders(options),
      ...(signal ? { signal } : {}),
    },
  ), signal);
  const responseText = await waitForOperation(
    readBoundedCliBridgeResponse(response, MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES),
    signal,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`cli-bridge run status ${response.status}: ${responseText}`);
  }
  const snapshot = runSnapshot(responseText);
  bindCliBridgeRunSnapshot(run, snapshot);
  return snapshot;
}

function bindCliBridgeRunSnapshot(run: CliBridgeRun, snapshot: CliBridgeRunSnapshot): void {
  if (snapshot.controlRef === undefined) {
    throw new Error("cli-bridge run status omitted exact run coordinates");
  }
  bindExactControlRef(run, snapshot.controlRef);
}

function bindExactControlRef(run: CliBridgeRun, controlRef: AgentExactRunControlRef): void {
  if (
    controlRef.runId !== run.id ||
    controlRef.provider !== run.provider ||
    controlRef.environmentId !== run.environmentId ||
    controlRef.sessionId !== run.sessionId ||
    controlRef.executionId !== run.executionId ||
    (run.requestDigest !== undefined && controlRef.requestDigest !== run.requestDigest)
  ) {
    throw new Error("cli-bridge returned another retained run identity");
  }
  run.requestDigest = controlRef.requestDigest;
  run.controlRef = Object.freeze(controlRef);
}

export interface CliBridgeRunLookupInput {
  readonly runId: string;
  readonly environmentId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly signal?: AbortSignal;
}

/** Recover one exact Bridge run after dispatch succeeded but local admission did not. */
export async function lookupExactCliBridgeRun(
  options: CliBridgeProviderOptions,
  providerName: string,
  input: CliBridgeRunLookupInput,
): Promise<AgentExactRunControlRef | null> {
  const runId = assertCliBridgeRunId(
    AgentExactRunControlRefSchema.shape.runId.parse(input.runId),
  );
  const environmentId = AgentExactRunControlRefSchema.shape.environmentId.parse(
    input.environmentId,
  );
  const sessionId = AgentExactRunControlRefSchema.shape.sessionId.parse(input.sessionId);
  const executionId = AgentExactRunControlRefSchema.shape.executionId.parse(
    input.executionId,
  );
  const transport = createCliBridgeTransport(options);
  const run: CliBridgeRun = {
    id: runId,
    provider: providerName,
    environmentId,
    sessionId,
    executionId,
    turnId: executionId,
    requestBody: "",
    readers: new Set<AbortController>(),
  };
  try {
    const snapshot = await getCliBridgeRun(
      options,
      transport,
      run,
      undefined,
      input.signal,
    );
    return snapshot?.controlRef ?? null;
  } finally {
    await transport.close();
  }
}

export function agentSessionStatusFromRun(
  snapshot: CliBridgeRunSnapshot,
): AgentSessionStatus {
  if (snapshot.status === "done") return "completed";
  if (snapshot.status === "error") return "failed";
  if (snapshot.status === "cancelled") return "cancelled";
  if (snapshot.status === "unknown") return "unknown";
  return "running";
}
