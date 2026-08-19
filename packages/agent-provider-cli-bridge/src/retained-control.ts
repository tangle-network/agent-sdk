import {
  AgentExactRunControlRefSchema,
  AgentRunCancellationAcknowledgementSchema,
  AgentRunCancellationRequestSchema,
  agentRunCancellationAcknowledgementMatchesRequest,
  type AgentExactRunControlRef,
  type AgentRunCancellationAcknowledgement,
  type AgentRunCancellationRequest,
  type Sha256Digest,
} from "@tangle-network/agent-interface";
import type { AgentSessionStatus } from "@tangle-network/agent-interface/environment-provider";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import type { CliBridgeRun, CliBridgeRunSnapshot } from "./retained-run-state.js";
import type { CliBridgeResponse, CliBridgeTransport } from "./transport.js";
import { requestHeaders, trimSlash } from "./transport.js";
import { cancelSnapshot, runSnapshot } from "./wire.js";

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
  if (requestDigest !== null) run.requestDigest = requestDigest;
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
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(run.id)}/cancel`,
    {
      method: "POST",
      headers: requestHeaders(options),
      body: "{}",
    },
  );
  if (!response.ok) {
    throw new Error(`cli-bridge cancel ${response.status}: ${await response.text()}`);
  }
  let snapshot: CliBridgeRunSnapshot | null = cancelSnapshot(await response.text());
  assertCliBridgeRunSnapshotIdentity(snapshot, run.id);
  const waitBudgetMs = options.cancelWaitMs ?? 30_000;
  const deadline = Date.now() + waitBudgetMs;
  while (!snapshot.terminal) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    snapshot = await getCliBridgeRun(
      options,
      transport,
      run,
      Math.min(remainingMs, 30_000),
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

function clearCancellation(
  run: CliBridgeRun,
  cancellation: Promise<CliBridgeRunSnapshot>,
): void {
  if (run.cancellation === cancellation) run.cancellation = undefined;
}

function waitForOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
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
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(run.id)}/cancel`,
    {
      method: "POST",
      headers: requestHeaders(options),
      body: JSON.stringify(exactRequest),
      ...(signal ? { signal } : {}),
    },
  );
  const responseText = await response.text();
  if (!response.ok && response.status !== 409) {
    throw new Error(`cli-bridge cancel ${response.status}: ${responseText}`);
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
  if (!agentRunCancellationAcknowledgementMatchesRequest(exactRequest, acknowledgement)) {
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
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(run.id)}${query}`,
    {
      method: "GET",
      headers: requestHeaders(options),
      ...(signal ? { signal } : {}),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`cli-bridge run status ${response.status}: ${await response.text()}`);
  }
  const snapshot = runSnapshot(await response.text());
  assertCliBridgeRunSnapshotIdentity(snapshot, run.id, run.requestDigest);
  return snapshot;
}

function assertCliBridgeRunSnapshotIdentity(
  snapshot: CliBridgeRunSnapshot,
  expectedRunId: string,
  expectedRequestDigest?: Sha256Digest,
): void {
  if (snapshot.id !== expectedRunId) {
    throw new Error(
      `cli-bridge returned run "${snapshot.id}" for requested run "${expectedRunId}"`,
    );
  }
  if (
    expectedRequestDigest !== undefined &&
    snapshot.requestDigest !== expectedRequestDigest
  ) {
    throw new Error(
      `cli-bridge returned request digest "${snapshot.requestDigest}" for run "${expectedRunId}"`,
    );
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
