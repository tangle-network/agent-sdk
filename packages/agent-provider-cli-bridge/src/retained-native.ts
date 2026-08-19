import type {
  AgentEnvironmentCapabilities,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  AgentNativeContextContinuationResultSchema,
  AgentExactRunControlRefSchema,
  NativeContextBoundaryProofSchema,
  NativeContextContinuationRequestSchema,
  RequestedInteractionsSchema,
  agentNativeContextContinuationResultMatchesRequest,
  canonicalCandidateDigest,
  nativeContextContinuationTurnDigest,
  type AgentExactRunControlRef,
  type AgentNativeContextContinuationOptions,
  type AgentNativeContextContinuationResult,
  type AgentProfile,
  type Sha256Digest,
  type NativeContextBoundaryProof,
  type NativeContextContinuationRequest,
  type RequestedInteractions,
} from "@tangle-network/agent-interface";
import { CliBridgeRequestRejectedError } from "./retained-stream.js";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import type { CliBridgeRun } from "./retained-run-state.js";
import {
  advanceCliBridgeRun,
  exactControlRefForRun,
} from "./retained-run-state.js";
import type { CliBridgeResponse, CliBridgeTransport } from "./transport.js";
import {
  requestHeaders,
  trimSlash,
} from "./transport.js";
import {
  inlineProfile,
  safeJson,
  resolveBridgeModel,
  toRetainedSessionBody,
  toRetainedTurnBody,
} from "./wire.js";

/** The server-owned native session identity cached by one provider handle. */
export interface CliBridgeNativeSession {
  readonly id: string;
  readonly model: string;
  readonly createRequestDigest: Sha256Digest;
}

export type CliBridgeNativeSessionCache = Map<
  string,
  Promise<CliBridgeNativeSession>
>;

const MAX_NATIVE_CONTINUATION_RESPONSE_BYTES = 1_048_576;

/** Interactions are valid only for the native retained Pi contract. */
export function supportsCliBridgeNativeInteractions(
  capabilities: AgentEnvironmentCapabilities,
  selectedBackend?: string,
): boolean {
  const interactions = capabilities.interactions;
  const retainedControl = capabilities.retainedControl;
  return Boolean(
    selectedBackend === "pi" &&
      piInteractionCapabilitiesMatch(interactions) &&
      capabilities.streaming.live &&
      capabilities.streaming.replay &&
      capabilities.streaming.detach &&
      capabilities.streaming.turnIdempotency &&
      capabilities.sessions.continue &&
      retainedControl?.exactRunIdentity &&
      retainedControl.resultIdentity &&
      retainedControl.eventIdentity &&
      retainedControl.cancellationIdempotency,
  );
}

/** Native continuation is exposed only when the Bridge proves both guarantees. */
export function supportsCliBridgeNativeContinuation(
  capabilities: AgentEnvironmentCapabilities,
): boolean {
  return Boolean(
    capabilities.sessions.continue &&
      capabilities.nativeContinuation?.atomicBoundary === true &&
      capabilities.nativeContinuation.requestIdempotency === true,
  );
}

/** Reject posture the selected environment did not advertise before transport use. */
export function assertCliBridgeRequestedInteractions(
  capabilities: AgentEnvironmentCapabilities,
  requested: RequestedInteractions | undefined,
): void {
  if (requested === undefined) return;
  const parsed = RequestedInteractionsSchema.parse(requested);
  const advertised = new Set(capabilities.interactions?.kinds ?? []);
  const unsupported = Object.keys(parsed).filter((kind) => !advertised.has(kind));
  if (unsupported.length > 0) {
    throw new Error(
      `cli-bridge environment does not advertise requested interaction kind(s): ${unsupported.join(", ")}`,
    );
  }
}

/** Keep capability discovery and every native turn on one exact model route. */
export function assertCliBridgeNativeTurnModel(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  selectedModel: string | undefined,
): void {
  if (selectedModel === undefined) {
    throw new Error("cli-bridge native interactions require an environment model");
  }
  const requestedModel = resolveBridgeModel(
    options,
    environmentInput,
    turn,
    inlineProfile(environmentInput.profile),
  );
  if (requestedModel !== selectedModel) {
    throw new Error(
      `cli-bridge native environment model is ${JSON.stringify(selectedModel)}; create another environment for ${JSON.stringify(requestedModel)}`,
    );
  }
}

function piInteractionCapabilitiesMatch(
  interactions: AgentEnvironmentCapabilities["interactions"],
): boolean {
  return Boolean(
    interactions &&
      interactions.kinds.includes("permission") &&
      interactions.answerFieldTypes.includes("select") &&
      interactions.responseScopes.includes("interaction") &&
      interactions.secretAnswers === false &&
      interactions.concurrentRequests === false &&
      interactions.replay === true &&
      interactions.responseIdempotency === true,
  );
}

/** Read the Bridge-owned exact boundary for the current retained run. */
export async function readCliBridgeNativeContextBoundary(
  options: CliBridgeProviderOptions,
  providerName: string,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
  signal?: AbortSignal,
): Promise<NativeContextBoundaryProof | null> {
  const controlRef = currentCliBridgeControlRef(run, providerName);
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/sessions/${encodeURIComponent(controlRef.sessionId)}`,
    {
      method: "GET",
      headers: requestHeaders(options),
      ...(signal ? { signal } : {}),
    },
  );
  const responseText = await readBoundedResponseText(response, signal);
  if (!response.ok) {
    throw new CliBridgeRequestRejectedError(response.status, responseText);
  }
  const parsed = safeJson(responseText);
  if (!parsed) {
    throw new Error("cli-bridge native session boundary response is not a JSON object");
  }
  if (parsed.id !== undefined && parsed.id !== controlRef.sessionId) {
    throw new Error("cli-bridge native session boundary response targets another session");
  }
  if (parsed.context_boundary === null) return null;
  const proof = NativeContextBoundaryProofSchema.safeParse(parsed.context_boundary);
  if (!proof.success) {
    throw new Error("cli-bridge native session returned an invalid context boundary", {
      cause: proof.error,
    });
  }
  assertBoundaryControlRef(proof.data, controlRef);
  return proof.data;
}

/** Send one canonical same-session continuation and advance the live run identity. */
export async function continueCliBridgeNative(
  options: CliBridgeProviderOptions,
  providerName: string,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
  request: NativeContextContinuationRequest,
  continuationOptions: AgentNativeContextContinuationOptions,
  runs: Map<string, CliBridgeRun>,
): Promise<AgentNativeContextContinuationResult> {
  const exactRequest = NativeContextContinuationRequestSchema.parse(request);
  const current = currentCliBridgeControlRef(run, providerName);
  if (!sameControlRef(current, exactRequest.run)) {
    throw new Error("cli-bridge native continuation targets another retained run");
  }
  if (
    nativeContextContinuationTurnDigest(continuationOptions.turn) !==
    exactRequest.turnDigest
  ) {
    throw new Error("cli-bridge native continuation turn does not match its request digest");
  }
  const operation = continuationSignal(continuationOptions);
  try {
    operation.signal?.throwIfAborted();
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/sessions/${encodeURIComponent(exactRequest.run.sessionId)}/continue`,
      {
        method: "POST",
        headers: requestHeaders(options),
        body: JSON.stringify({ request: exactRequest, turn: continuationOptions.turn }),
        ...(operation.signal ? { signal: operation.signal } : {}),
      },
    );
    const responseText = await readBoundedResponseText(response, operation.signal);
    const outcome = parseNativeContinuationResult(responseText);
    assertContinuationAcknowledgementBinding(exactRequest, outcome);
    if (
      outcome.acknowledgement.status === "accepted" ||
      outcome.acknowledgement.status === "replayed"
    ) {
      if (
        !agentNativeContextContinuationResultMatchesRequest(exactRequest, outcome)
      ) {
        throw new Error(
          "cli-bridge native continuation returned an acknowledgement for another request",
        );
      }
      if (!response.ok) {
        throw new Error(
          `cli-bridge native continuation returned HTTP ${response.status} for an accepted result`,
        );
      }
      if (!("controlRef" in outcome)) {
        throw new Error("cli-bridge native continuation omitted its current control reference");
      }
      advanceCliBridgeRun(run, outcome.controlRef, providerName, runs);
    }
    return outcome;
  } finally {
    operation.dispose();
  }
}

function currentCliBridgeControlRef(
  run: CliBridgeRun,
  providerName: string,
): AgentExactRunControlRef {
  if (run.controlRef !== undefined) {
    const controlRef = AgentExactRunControlRefSchema.parse(run.controlRef);
    if (!sameControlRef(controlRef, exactControlRefForRun(run, providerName))) {
      throw new Error("cli-bridge retained run has a conflicting control reference");
    }
    return controlRef;
  }
  const controlRef = exactControlRefForRun(run, providerName);
  run.controlRef = controlRef;
  return controlRef;
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

function assertBoundaryControlRef(
  proof: NativeContextBoundaryProof,
  controlRef: AgentExactRunControlRef,
): void {
  if (
    proof.runId !== controlRef.runId ||
    proof.provider !== controlRef.provider ||
    proof.environmentId !== controlRef.environmentId ||
    proof.sessionId !== controlRef.sessionId ||
    proof.executionId !== controlRef.executionId ||
    proof.requestDigest !== controlRef.requestDigest
  ) {
    throw new Error("cli-bridge native session boundary does not bind to the retained run");
  }
}

function parseNativeContinuationResult(
  value: string,
): AgentNativeContextContinuationResult {
  const parsed = safeJson(value);
  try {
    return AgentNativeContextContinuationResultSchema.parse(parsed);
  } catch (error) {
    throw new Error("cli-bridge native continuation returned an invalid result", {
      cause: error,
    });
  }
}

function assertContinuationAcknowledgementBinding(
  request: NativeContextContinuationRequest,
  outcome: AgentNativeContextContinuationResult,
): void {
  const acknowledgement = outcome.acknowledgement;
  if (
    acknowledgement.operationId !== request.operationId ||
    acknowledgement.requestDigest !== request.requestDigest ||
    acknowledgement.historyMessagesSent !== 0
  ) {
    throw new Error("cli-bridge native continuation acknowledgement is not bound to the request");
  }
  if (acknowledgement.actualBoundary !== undefined) {
    assertBoundaryControlRef(acknowledgement.actualBoundary, request.run);
  }
}

function continuationSignal(options: AgentNativeContextContinuationOptions): {
  signal?: AbortSignal;
  dispose: () => void;
} {
  const timeoutMs = options.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
  ) {
    throw new Error("native continuation timeoutMs must be an integer from 0 through 2147483647");
  }
  if (timeoutMs === undefined) {
    return { signal: options.signal, dispose: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("native continuation timed out", "TimeoutError"));
  }, timeoutMs);
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([options.signal, controller.signal]);
  return {
    signal,
    dispose: () => clearTimeout(timer),
  };
}

async function readBoundedResponseText(
  response: CliBridgeResponse,
  signal?: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      Number.isSafeInteger(parsedLength) &&
      parsedLength > MAX_NATIVE_CONTINUATION_RESPONSE_BYTES
    ) {
      throw new Error("cli-bridge native continuation response exceeds its byte limit");
    }
  }
  if (response.body === null) {
    signal?.throwIfAborted();
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_NATIVE_CONTINUATION_RESPONSE_BYTES) {
      throw new Error("cli-bridge native continuation response exceeds its byte limit");
    }
    return text;
  }
  const iterator = response.body[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let complete = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await iterator.next();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_NATIVE_CONTINUATION_RESPONSE_BYTES) {
        throw new Error("cli-bridge native continuation response exceeds its byte limit");
      }
      text += decoder.decode(next.value, { stream: true });
    }
    complete = true;
    return text + decoder.decode();
  } finally {
    if (!complete) {
      await iterator.return?.();
    }
  }
}

interface NativeSessionView extends CliBridgeNativeSession {}

/**
 * Create or reuse the server's retained native session for one external id.
 *
 * The cache stores the promise so concurrent first turns cannot create two
 * native sessions for the same id.
 */
export async function ensureCliBridgeNativeSession(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  sessionId: string,
  transport: CliBridgeTransport,
  sessions: CliBridgeNativeSessionCache,
  signal?: AbortSignal,
): Promise<CliBridgeNativeSession> {
  const profile = inlineProfile(environmentInput.profile);
  const model = resolveBridgeModel(options, environmentInput, turn, profile);
  const existing = sessions.get(sessionId);
  if (existing) {
    const session = await existing;
    assertNativeSessionModel(session, model);
    return session;
  }

  const pending = createCliBridgeNativeSession(
    options,
    environmentInput,
    profile,
    sessionId,
    model,
    transport,
    signal,
  );
  sessions.set(sessionId, pending);
  try {
    const session = await pending;
    assertNativeSessionModel(session, model);
    return session;
  } catch (error) {
    if (sessions.get(sessionId) === pending) sessions.delete(sessionId);
    throw error;
  }
}

async function createCliBridgeNativeSession(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  profile: AgentProfile | undefined,
  sessionId: string,
  model: string,
  transport: CliBridgeTransport,
  signal?: AbortSignal,
): Promise<CliBridgeNativeSession> {
  const body = toRetainedSessionBody(options, environmentInput, profile, sessionId, model);
  const createRequestDigest = canonicalCandidateDigest(body);
  const url = `${trimSlash(options.baseUrl)}/v1/sessions`;
  const init = {
    method: "POST" as const,
    headers: requestHeaders(options),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  };
  const response = await transport.fetch(url, init);
  if (response.status === 409) {
    return recoverConflictingNativeSession(
      options,
      sessionId,
      model,
      createRequestDigest,
      transport,
      signal,
      response,
    );
  }
  if (!response.ok) {
    throw new CliBridgeRequestRejectedError(response.status, await response.text());
  }
  return parseNativeSessionView(await response.text(), sessionId, model, createRequestDigest);
}

async function recoverConflictingNativeSession(
  options: CliBridgeProviderOptions,
  sessionId: string,
  model: string,
  createRequestDigest: Sha256Digest,
  transport: CliBridgeTransport,
  signal: AbortSignal | undefined,
  conflictResponse: { text(): Promise<string> },
): Promise<CliBridgeNativeSession> {
  await conflictResponse.text();
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: requestHeaders(options),
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    throw new CliBridgeRequestRejectedError(
      response.status,
      `session ${JSON.stringify(sessionId)} could not be recovered: ${await response.text()}`,
    );
  }
  return parseNativeSessionView(
    await response.text(),
    sessionId,
    model,
    createRequestDigest,
  );
}

function parseNativeSessionView(
  value: string,
  expectedId: string,
  expectedModel: string,
  expectedCreateRequestDigest: Sha256Digest,
): NativeSessionView {
  const parsed = safeJson(value);
  const id = parsed?.id;
  const model = parsed?.model;
  const digest = parsed?.create_request_digest;
  const parsedDigest = AgentExactRunControlRefSchema.shape.requestDigest.safeParse(digest);
  if (
    typeof id !== "string" ||
    typeof model !== "string" ||
    !parsedDigest.success
  ) {
    throw new Error("cli-bridge retained session returned an invalid session view");
  }
  if (id !== expectedId) {
    throw new Error(
      `cli-bridge returned session ${JSON.stringify(id)} for requested session ${JSON.stringify(expectedId)}`,
    );
  }
  if (model !== expectedModel) {
    throw new Error(
      `cli-bridge retained session ${JSON.stringify(expectedId)} is bound to model ${JSON.stringify(model)}`,
    );
  }
  if (parsedDigest.data !== expectedCreateRequestDigest) {
    throw new Error(
      `cli-bridge retained session ${JSON.stringify(expectedId)} has a different creation request digest`,
    );
  }
  return {
    id,
    model,
    createRequestDigest: parsedDigest.data,
  };
}

function assertNativeSessionModel(
  session: CliBridgeNativeSession,
  expectedModel: string,
): void {
  if (session.model !== expectedModel) {
    throw new Error(
      `cli-bridge retained session ${JSON.stringify(session.id)} cannot change model from ${JSON.stringify(session.model)} to ${JSON.stringify(expectedModel)}`,
    );
  }
}

/** Admit one native retained turn and bind its server digest to the run. */
export async function beginCliBridgeNativeTurn(
  options: CliBridgeProviderOptions,
  providerName: string,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  run: CliBridgeRun,
  transport: CliBridgeTransport,
  sessions: CliBridgeNativeSessionCache,
  signal?: AbortSignal,
  onAdmission?: () => void,
): Promise<void> {
  if (!run.sessionId) {
    throw new Error("cli-bridge native retained turns require a session id");
  }
  const body = toRetainedTurnBody(turn, run, providerName);
  const nativeSession = await ensureCliBridgeNativeSession(
    options,
    environmentInput,
    turn,
    run.sessionId,
    transport,
    sessions,
    signal,
  );
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/sessions/${encodeURIComponent(run.sessionId)}/turns`,
    {
      method: "POST",
      headers: requestHeaders(options),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    throw new CliBridgeRequestRejectedError(response.status, await response.text());
  }
  onAdmission?.();
  const parsed = safeJson(await response.text());
  const responseSession = parsed?.session;
  const responseRun = parsed?.run;
  const responseSessionId =
    responseSession && typeof responseSession === "object"
      ? (responseSession as Record<string, unknown>).id
      : undefined;
  const responseSessionModel =
    responseSession && typeof responseSession === "object"
      ? (responseSession as Record<string, unknown>).model
      : undefined;
  const responseSessionDigest =
    responseSession && typeof responseSession === "object"
      ? (responseSession as Record<string, unknown>).create_request_digest
      : undefined;
  const parsedSessionDigest = AgentExactRunControlRefSchema.shape.requestDigest.safeParse(
    responseSessionDigest,
  );
  const runId = responseRun && typeof responseRun === "object"
    ? (responseRun as Record<string, unknown>).id
    : undefined;
  const responseSessionIdFromRun = responseRun && typeof responseRun === "object"
    ? (responseRun as Record<string, unknown>).sessionId
    : undefined;
  const executionId = responseRun && typeof responseRun === "object"
    ? (responseRun as Record<string, unknown>).executionId
    : undefined;
  const requestDigestValue = responseRun && typeof responseRun === "object"
    ? (responseRun as Record<string, unknown>).requestDigest
    : undefined;
  const requestDigest = AgentExactRunControlRefSchema.shape.requestDigest.safeParse(
    requestDigestValue,
  );
  if (
    !parsed ||
    typeof responseSessionId !== "string" ||
    responseSessionId !== run.sessionId ||
    responseSessionModel !== nativeSession.model ||
    !parsedSessionDigest.success ||
    parsedSessionDigest.data !== nativeSession.createRequestDigest ||
    typeof runId !== "string" ||
    runId !== run.id ||
    typeof responseSessionIdFromRun !== "string" ||
    responseSessionIdFromRun !== run.sessionId ||
    typeof executionId !== "string" ||
    executionId !== run.executionId ||
    !requestDigest.success
  ) {
    throw new Error("cli-bridge retained turn returned mismatched run coordinates");
  }
  if (run.requestDigest !== undefined && run.requestDigest !== requestDigest.data) {
    throw new Error("cli-bridge retained turn changed the admitted request digest");
  }
  run.requestDigest = requestDigest.data;
}
