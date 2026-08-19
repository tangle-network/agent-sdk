import type {
  AgentEnvironmentCapabilities,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  AgentExactRunControlRefSchema,
  RequestedInteractionsSchema,
  canonicalCandidateDigest,
  type AgentProfile,
  type Sha256Digest,
  type RequestedInteractions,
} from "@tangle-network/agent-interface";
import { CliBridgeRequestRejectedError } from "./retained-stream.js";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import type { CliBridgeRun } from "./retained-run-state.js";
import type { CliBridgeTransport } from "./transport.js";
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
): Promise<void> {
  if (!run.sessionId) {
    throw new Error("cli-bridge native retained turns require a session id");
  }
  const nativeSession = await ensureCliBridgeNativeSession(
    options,
    environmentInput,
    turn,
    run.sessionId,
    transport,
    sessions,
    signal,
  );
  const body = toRetainedTurnBody(turn, run, providerName);
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
