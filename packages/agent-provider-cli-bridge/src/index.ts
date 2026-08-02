import { createHash } from "node:crypto";
import {
  AgentEnvironmentCapabilitiesSchema,
  AgentRunCancellationAcknowledgementSchema,
  AgentRunCancellationRequestSchema,
  AgentRunControlRefSchema,
  AgentTurnResultSchema,
  InteractionAcknowledgementSchema,
  InteractionResponseCommandSchema,
  NativeContextBoundaryProofSchema,
  RuntimeEventEnvelopeSchema,
  agentRunCancellationRequestDigest,
  canonicalCandidateDigest,
  agentRunCancellationAcknowledgementMatchesRequest,
  sha256DigestSchema,
  snapshotAgentProfile,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentProfileRef,
  AgentSession,
  AgentSessionRef,
  AgentSessionStatus,
  AgentTurnResult,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentProfile,
  AgentRunControlRef,
  AgentRunCancellationRequest,
  AgentRunCancellationAcknowledgement,
  InteractionAcknowledgement,
  InteractionResponseCommand,
  InputPart,
  MessagePartUpdatedEvent,
  NativeContextBoundaryProof,
  RuntimeEventEnvelope,
  StreamEvent,
  TextPart,
  TokenUsage,
  ToolPart,
} from "@tangle-network/agent-interface";
import { Agent, fetch as undiciFetch } from "undici";

export interface CliBridgeProviderOptions {
  baseUrl: string;
  bearerToken?: string;
  defaultModel?: string;
  defaultMode?: "byob" | "hosted-safe" | "hosted-sandboxed";
  defaultExecution?: { kind: "host" } | {
    kind: "sandbox";
    repoUrl?: string;
    gitRef?: string;
    capability?: string;
    ttlSeconds?: number;
  };
  /** Maximum wait for response headers. Defaults to no timeout. */
  headersTimeoutMs?: number;
  /** Maximum idle time between response body chunks. Defaults to no timeout. */
  bodyTimeoutMs?: number;
  /** Maximum wait for cli-bridge to confirm cancellation. Defaults to 30 seconds. */
  cancelWaitMs?: number;
  fetch?: typeof fetch;
  name?: string;
  capabilities?: AgentEnvironmentCapabilities;
}

export function createCliBridgeProvider(options: CliBridgeProviderOptions): AgentEnvironmentProvider {
  assertTimeout(options.headersTimeoutMs, "headersTimeoutMs");
  assertTimeout(options.bodyTimeoutMs, "bodyTimeoutMs");
  assertTimeout(options.cancelWaitMs, "cancelWaitMs");
  const name = options.name ?? "cli-bridge";
  const configuredCapabilities = options.capabilities
    ? AgentEnvironmentCapabilitiesSchema.parse(options.capabilities)
    : undefined;
  let discoveredCapabilities: Promise<AgentEnvironmentCapabilities> | undefined;
  const providerCapabilities = (): AgentEnvironmentCapabilities | Promise<AgentEnvironmentCapabilities> => {
    if (configuredCapabilities) return configuredCapabilities;
    if (!options.defaultModel) return defaultCliBridgeCapabilities();
    discoveredCapabilities ??= discoverRetainedCapabilities(options, options.defaultModel)
      .catch((error) => {
        discoveredCapabilities = undefined;
        throw error;
      });
    return discoveredCapabilities;
  };
  const getBridgeEnvironment = async (): Promise<AgentEnvironment | null> => {
    const capabilities = await providerCapabilities();
    if (!retainedCapabilitiesAdmit(capabilities)) return null;
    const transport = createTransport(options);
    try {
      const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/sessions?limit=1`, {
        method: "GET",
        headers: requestHeaders(options),
      });
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        await transport.close();
        return null;
      }
      if (!response.ok) {
        throw new CliBridgeRequestRejectedError(response.status, await response.text());
      }
      const body = parseJsonText(await response.text(), "cli-bridge session list");
      const first = Array.isArray(body.data) ? body.data[0] : undefined;
      if (first !== undefined) parseRetainedSessionView(first);
      return createRetainedEnvironmentShell(
        options,
        transport,
        name,
        true,
      );
    } catch (error) {
      await transport.close();
      throw error;
    }
  };
  const getEnvironment = async (id: string): Promise<AgentEnvironment | null> => {
    if (options.capabilities?.streaming.detach === false) return null;
    if (id === RETAINED_ENVIRONMENT_ID) return getBridgeEnvironment();
    const transport = createTransport(options);
    try {
      const view = await getRetainedSessionView(options, transport, id);
      if (!view) {
        await transport.close();
        return null;
      }
      if (!retainedCapabilitiesAdmit(view.capabilities)) {
        await transport.close();
        return null;
      }
      return createRetainedEnvironment(
        options,
        transport,
        {
          profile: { name: "reconnected" },
          idempotencyKey: id,
        },
        name,
        createRetainedState(view),
        false,
      );
    } catch (error) {
      await transport.close();
      if (error instanceof CliBridgeRequestRejectedError && error.status === 404) return null;
      throw error;
    }
  };
  const listEnvironments = async () => {
    if (options.capabilities?.sessions.list === false) return [];
    const transport = createTransport(options);
    try {
      const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/sessions`, {
        method: "GET",
        headers: requestHeaders(options),
      });
      if (response.status === 404 || response.status === 405 || response.status === 501) return [];
      if (!response.ok) {
        throw new CliBridgeRequestRejectedError(response.status, await response.text());
      }
      const body = parseJsonText(await response.text(), "cli-bridge session list");
      const data = Array.isArray(body?.data) ? body.data : [];
      return data.map((item: unknown) => {
        const view = parseRetainedSessionView(item);
        return {
          id: view.id,
          provider: name,
          status: retainedEnvironmentStatus(view.status),
          metadata: {
            backend: view.backend,
            model: view.model,
            capabilities: view.capabilities,
          },
        };
      });
    } finally {
      await transport.close();
    }
  };
  const provider: AgentEnvironmentProvider & { readonly supportsStableEventIdentity: true } = {
    name,
    supportsStableEventIdentity: true,
    capabilities: providerCapabilities,
    get: getEnvironment,
    list: listEnvironments,
    async create(input) {
      const profile = snapshotInlineProfile(input.profile);
      const environmentInput = profile ? { ...input, profile } : input;
      const transport = createTransport(options);
      const model = tryResolveBridgeModel(options, input, profile);
      let retained: RetainedSessionState | undefined;
      try {
        if (
          options.defaultModel &&
          model &&
          (profile || typeof input.profile === "string") &&
          options.capabilities?.streaming.detach !== false &&
          retainedCreateInputSupported(options, environmentInput)
        ) {
          retained = await tryCreateRetainedSession(options, transport, environmentInput, profile ?? input.profile, model);
        }
      } catch (error) {
        await transport.close();
        throw error;
      }
      if (retained) {
        if (retained.view.capabilities.streaming.replay && retained.view.capabilities.sessions.continue) {
          provider.get = getEnvironment;
        }
        if (retained.view.capabilities.sessions.list) provider.list = listEnvironments;
        return createRetainedEnvironment(options, transport, environmentInput, name, retained, true);
      }
      return createLegacyEnvironment(options, transport, environmentInput, name);
    },
  };
  return provider;
}

const RETAINED_ENVIRONMENT_ID = "cli-bridge";

interface RetainedSessionView {
  readonly id: string;
  readonly create_request_digest: string;
  readonly backend: string;
  readonly model: string;
  readonly status: RetainedStatus;
  readonly run_id: string | null;
  readonly internal_session_id: string | null;
  readonly turns: number;
  readonly capabilities: AgentEnvironmentCapabilities;
  readonly profile_materialization_receipt: Record<string, unknown> | null;
  readonly context_boundary: Record<string, unknown> | null;
  readonly run?: RetainedRunSnapshot;
}

type RetainedStatus =
  | "created"
  | "idle"
  | "running"
  | "completed"
  | "cancelled"
  | "closed"
  | "unknown";

interface RetainedRunSnapshot {
  readonly id: string;
  readonly requestDigest: `sha256:${string}`;
  readonly status: "running" | "done" | "error" | "cancelled" | "unknown";
  readonly terminal: boolean;
  readonly sessionId?: string;
  readonly [key: string]: unknown;
}

type RetainedCancelEffect = "cancel_requested" | "cancelled" | "not_live" | "unknown";

interface ExactRetainedCancelOptions {
  readonly executionId?: string;
  readonly operationId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

interface RetainedSessionState {
  readonly sessionId: string;
  readonly model: string;
  readonly capabilities: AgentEnvironmentCapabilities;
  readonly profile?: AgentProfile;
  view: RetainedSessionView;
  profileReceipt?: Record<string, unknown>;
  profileReceiptDigest?: string;
  controlRef?: AgentRunControlRef;
  activeReaders: Set<AbortController>;
  activeRun?: RetainedRunSnapshot;
  cancelOperations: Map<string, {
    digest: string;
    promise: Promise<AgentRunCancellationAcknowledgement>;
  }>;
  cancelRequested?: boolean;
  suppressReaderDetach?: boolean;
}

function createLegacyEnvironment(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  input: CreateAgentEnvironmentInput,
  name: string,
): AgentEnvironment {
  const environmentId = input.idempotencyKey ?? crypto.randomUUID();
  const runs = new Map<string, CliBridgeRun>();
  const readers = new Set<AbortController>();
  let destroyed = false;
  let closePromise: Promise<void> | undefined;
  const stream = async function* (
    turn: AgentTurnInput,
  ): AsyncIterable<AgentEnvironmentEvent> {
    if (destroyed) throw new Error("cli-bridge environment is destroyed");
    yield* streamTrackedCliBridgeTurn(
      options,
      input,
      turn,
      transport,
      environmentId,
      runs,
      readers,
    );
  };
  const environment = {
    id: environmentId,
    provider: name,
    ...(input.name ? { name: input.name } : {}),
    status: async () => (destroyed ? "stopped" : "running"),
    stream,
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
          throw new AggregateError(failures, "cli-bridge environment cancellation failed");
        }
        cancellationsConfirmed = true;
        for (const reader of readers) {
          reader.abort(
            new DOMException("cli-bridge environment was destroyed", "AbortError"),
          );
        }
        await transport.close();
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
}

interface RetainedEnvironmentContext {
  readonly options: CliBridgeProviderOptions;
  readonly transport: CliBridgeTransport;
  readonly input: CreateAgentEnvironmentInput;
  readonly name: string;
  readonly state: RetainedSessionState;
  readonly isDestroyed: () => boolean;
}

async function tryCreateRetainedSession(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  input: CreateAgentEnvironmentInput,
  profile: AgentProfileRef,
  model: string,
): Promise<RetainedSessionState | undefined> {
  if (!options.defaultModel || !retainedCreateInputSupported(options, input)) return undefined;
  const sessionId = input.idempotencyKey ?? crypto.randomUUID();
  const body: Record<string, unknown> = {
    id: sessionId,
    model,
    interaction_policy: "interactive",
    agent_profile: profile,
    ...(options.defaultMode ? { mode: options.defaultMode } : {}),
    ...(input.workspace?.cwd ? { cwd: input.workspace.cwd } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const createRequestDigest = canonicalCandidateDigest(body);
  const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/sessions`, {
    method: "POST",
    headers: requestHeaders(options),
    body: JSON.stringify(body),
    signal: input.signal,
  });
  const text = await response.text();
  if (isRetainedUnsupported(response.status, text, response.headers)) return undefined;
  if (response.status === 409) {
    const existing = await getRetainedSessionView(options, transport, sessionId);
    if (existing) {
      if (
        existing.model !== model ||
        existing.create_request_digest !== createRequestDigest
      ) {
        throw new Error("cli-bridge retained session id is already bound to a different create request");
      }
      const state = createRetainedState(existing, typeof profile === "string" ? undefined : profile);
      if (!retainedCapabilitiesAdmit(state.capabilities) ||
        (typeof profile === "string" && !state.capabilities.profile.namedProfiles)) {
        throw new Error("cli-bridge existing retained session cannot satisfy the advertised retained contract");
      }
      return state;
    }
  }
  if (!response.ok) {
    throw new CliBridgeRequestRejectedError(response.status, text || "retained session creation rejected");
  }
  const parsed = parseJsonText(text, "cli-bridge retained session creation");
  const created = parseRetainedSessionView(parsed);
  if (created.create_request_digest !== createRequestDigest) {
    await closeUnusableRetainedSession(options, transport, sessionId);
    throw new Error("cli-bridge retained session changed its exact create request digest");
  }
  const state = createRetainedState(created, typeof profile === "string" ? undefined : profile);
  if (!retainedCapabilitiesAdmit(state.capabilities) ||
    (typeof profile === "string" && !state.capabilities.profile.namedProfiles)) {
    await closeUnusableRetainedSession(options, transport, sessionId);
    return undefined;
  }
  return state;
}

function retainedCreateInputSupported(
  options: CliBridgeProviderOptions,
  input: CreateAgentEnvironmentInput,
): boolean {
  const workspace = input.workspace;
  return options.defaultExecution === undefined &&
    input.resources === undefined &&
    input.env === undefined &&
    input.secrets === undefined &&
    input.providerOptions === undefined &&
    (workspace === undefined || (
      workspace.environment === undefined &&
      workspace.image === undefined &&
      workspace.repoUrl === undefined &&
      workspace.gitRef === undefined &&
      workspace.providerOptions === undefined
    ));
}

function retainedCapabilitiesAdmit(capabilities: AgentEnvironmentCapabilities): boolean {
  return capabilities.streaming.live &&
    capabilities.streaming.replay &&
    capabilities.streaming.detach &&
    capabilities.streaming.turnIdempotency &&
    capabilities.retainedControl?.exactRunIdentity === true &&
    capabilities.retainedControl.resultIdentity === true &&
    capabilities.retainedControl.eventIdentity === true &&
    capabilities.retainedControl.cancellationIdempotency === true &&
    capabilities.sessions.continue &&
    capabilities.sessions.list &&
    capabilities.sessions.messages;
}

async function discoverRetainedCapabilities(
  options: CliBridgeProviderOptions,
  model: string,
): Promise<AgentEnvironmentCapabilities> {
  const transport = createTransport(options);
  try {
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/capabilities?model=${encodeURIComponent(model)}`,
      { method: "GET", headers: requestHeaders(options) },
    );
    if ([404, 405, 501].includes(response.status)) return defaultCliBridgeCapabilities();
    const text = await response.text();
    if (!response.ok) {
      throw new CliBridgeRequestRejectedError(response.status, text || "capability discovery rejected");
    }
    return AgentEnvironmentCapabilitiesSchema.parse(
      parseJsonText(text, "cli-bridge capabilities"),
    );
  } finally {
    await transport.close();
  }
}

async function closeUnusableRetainedSession(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  sessionId: string,
): Promise<void> {
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/sessions/${encodeURIComponent(sessionId)}/close`,
    { method: "POST", headers: requestHeaders(options), body: "{}" },
  );
  const text = await response.text();
  if (!response.ok && response.status !== 404) {
    throw new CliBridgeRequestRejectedError(
      response.status,
      text || "cli-bridge could not close an unusable retained session",
    );
  }
}

function createRetainedState(
  view: RetainedSessionView,
  profile?: AgentProfile,
): RetainedSessionState {
  const state: RetainedSessionState = {
    sessionId: view.id,
    model: view.model,
    capabilities: view.capabilities,
    ...(profile ? { profile } : {}),
    view,
    activeReaders: new Set<AbortController>(),
    cancelOperations: new Map(),
  };
  observeRetainedView(state, view, "cli-bridge");
  return state;
}

function observeRetainedView(
  state: RetainedSessionState,
  view: RetainedSessionView,
  providerName: string,
): void {
  state.view = view;
  state.activeRun = view.run;
  if (view.run_id) {
    state.controlRef = makeControlRef(
      providerName,
      view.id,
      view.run_id,
      state.controlRef?.runId === view.run_id
        ? state.controlRef.executionId
        : view.run_id,
      view.run?.id === view.run_id ? view.run.requestDigest : undefined,
    );
  }
  if (view.profile_materialization_receipt !== null) {
    const receipt = frozenRecord(view.profile_materialization_receipt);
    const digest = canonicalCandidateDigest(receipt);
    if (state.profileReceiptDigest && state.profileReceiptDigest !== digest) {
      throw new Error("cli-bridge changed the immutable profile materialization receipt");
    }
    state.profileReceipt = receipt;
    state.profileReceiptDigest = digest;
  }
}

function makeControlRef(
  provider: string,
  sessionId: string,
  runId: string,
  executionId = runId,
  requestDigest?: AgentRunControlRef["requestDigest"],
): AgentRunControlRef {
  return Object.freeze(AgentRunControlRefSchema.parse({
    runId,
    provider,
    environmentId: RETAINED_ENVIRONMENT_ID,
    sessionId,
    executionId,
    ...(requestDigest ? { requestDigest } : {}),
  }));
}

function createRetainedEnvironment(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  input: CreateAgentEnvironmentInput,
  name: string,
  state: RetainedSessionState,
  ownsSession: boolean,
): AgentEnvironment {
  observeRetainedView(state, state.view, name);
  let destroyed = false;
  let closePromise: Promise<void> | undefined;
  const context: RetainedEnvironmentContext = {
    options,
    transport,
    input,
    name,
    state,
    isDestroyed: () => destroyed,
  };
  const supportsSession = retainedCapabilitiesAdmit(state.capabilities);
  const environment: AgentEnvironment = {
    id: RETAINED_ENVIRONMENT_ID,
    provider: name,
    ...(input.name ? { name: input.name } : {}),
    status: async () => {
      if (destroyed) return "stopped";
      const view = await refreshRetainedState(context, false);
      return retainedEnvironmentStatus(view.status);
    },
    stream: async function* (turn) {
      if (destroyed) throw new Error("cli-bridge environment is destroyed");
      yield* streamRetainedTurn(context, turn);
    },
    ...(supportsSession
      ? { dispatch: (turn: AgentTurnInput) => dispatchRetainedTurn(context, turn) }
      : {}),
    ...(supportsSession
      ? {
          session: (id: string, sessionOptions?: { controlRef?: AgentRunControlRef }) => {
            if (id !== state.sessionId) {
              throw new Error(`cli-bridge retained session ${JSON.stringify(id)} is not available in this environment`);
            }
            return createRetainedSession(context, state, sessionOptions?.controlRef);
          },
        }
      : {}),
    ...(state.capabilities.interactions
      ? {
          respondToInteraction: (command: InteractionResponseCommand, responseOptions?: { signal?: AbortSignal }) =>
            respondToRetainedInteraction(context, state, command, responseOptions?.signal),
        }
      : {}),
    ...(state.capabilities.placement
      ? {
          placement: async () => ({
            kind: options.defaultExecution?.kind === "sandbox" ? "sandbox" : "local",
            providerMetadata: { baseUrl: options.baseUrl, retained: true },
          }),
        }
      : {}),
    refresh: async () => {
      await refreshRetainedState(context, true);
    },
    async destroy() {
      if (closePromise) return closePromise;
      destroyed = true;
      const attempt = (async () => {
        state.suppressReaderDetach = true;
        if (ownsSession) {
          if (state.activeRun && !state.activeRun.terminal) {
            const cancellation = await cancelRetainedSession(
              context,
              state,
              state.controlRef,
            );
            if (cancellation.effect === "unknown") {
              throw new CliBridgeUnknownStateError(
                `cli-bridge could not prove cleanup of retained run ${JSON.stringify(state.controlRef?.runId)}`,
              );
            }
          }
          await closeRetainedSession(context, state);
        } else if (state.activeRun && !state.activeRun.terminal) {
          await detachRetainedSession(context, state);
        }
        for (const reader of state.activeReaders) {
          reader.abort(new DOMException("cli-bridge environment was destroyed", "AbortError"));
        }
        await transport.close();
      })();
      closePromise = attempt;
      try {
        await attempt;
      } catch (error) {
        closePromise = undefined;
        destroyed = false;
        state.suppressReaderDetach = false;
        throw error;
      }
    },
  };
  return environment;
}

interface RetainedShellContext {
  readonly options: CliBridgeProviderOptions;
  readonly transport: CliBridgeTransport;
  readonly name: string;
  readonly states: Map<string, RetainedSessionState>;
  readonly contexts: Map<string, RetainedEnvironmentContext>;
  readonly isDestroyed: () => boolean;
}

function createRetainedEnvironmentShell(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  name: string,
  supportsSession: boolean,
): AgentEnvironment {
  let destroyed = false;
  let closePromise: Promise<void> | undefined;
  const context: RetainedShellContext = {
    options,
    transport,
    name,
    states: new Map(),
    contexts: new Map(),
    isDestroyed: () => destroyed,
  };
  return {
    id: RETAINED_ENVIRONMENT_ID,
    provider: name,
    status: async () => (destroyed ? "stopped" : "running"),
    stream: async function* () {
      throw new Error("cli-bridge reconnect environment requires a retained session");
    },
    ...(supportsSession
      ? { session: (id: string, sessionOptions?: { controlRef?: AgentRunControlRef }) => createLazyRetainedSession(context, id, sessionOptions?.controlRef) }
      : {}),
    async destroy() {
      if (closePromise) return closePromise;
      destroyed = true;
      const attempt = (async () => {
        for (const [id, state] of context.states) {
          const retainedContext = context.contexts.get(id);
          if (!retainedContext) continue;
          state.suppressReaderDetach = true;
          if (state.activeRun && !state.activeRun.terminal) {
            await detachRetainedSession(retainedContext, state);
          }
          for (const reader of state.activeReaders) {
            reader.abort(new DOMException("cli-bridge environment was destroyed", "AbortError"));
          }
        }
        await transport.close();
      })();
      closePromise = attempt;
      try {
        await attempt;
      } catch (error) {
        closePromise = undefined;
        destroyed = false;
        for (const state of context.states.values()) state.suppressReaderDetach = false;
        throw error;
      }
    },
  };
}

function createLazyRetainedSession(
  shell: RetainedShellContext,
  sessionId: string,
  requestedControlRef?: AgentRunControlRef,
): AgentSession {
  let activeControlRef = requestedControlRef
    ? Object.freeze({ ...AgentRunControlRefSchema.parse(requestedControlRef) })
    : undefined;
  let loaded: Promise<AgentSession> | undefined;
  let loadedSession: AgentSession | undefined;
  const load = async (): Promise<AgentSession> => {
    if (shell.isDestroyed()) throw new Error("cli-bridge environment is destroyed");
    if (loaded) return loaded;
    loaded = (async () => {
      const view = await getRetainedSessionView(shell.options, shell.transport, sessionId);
      if (!view) throw new CliBridgeUnknownStateError(`cli-bridge retained session ${JSON.stringify(sessionId)} is unknown`);
      if (!retainedCapabilitiesAdmit(view.capabilities)) {
        throw new Error("cli-bridge retained session does not advertise the complete retained contract");
      }
      const state = createRetainedState(view);
      observeRetainedView(state, view, shell.name);
      const context: RetainedEnvironmentContext = {
        options: shell.options,
        transport: shell.transport,
        input: { profile: { name: "reconnected" }, idempotencyKey: sessionId },
        name: shell.name,
        state,
        isDestroyed: shell.isDestroyed,
      };
      const session = createRetainedSession(context, state, activeControlRef);
      loadedSession = session;
      activeControlRef = session.controlRef ?? activeControlRef;
      shell.states.set(sessionId, state);
      shell.contexts.set(sessionId, context);
      return session;
    })();
    try {
      return await loaded;
    } catch (error) {
      loaded = undefined;
      throw error;
    }
  };
  return {
    id: sessionId,
    get controlRef() {
      return loadedSession?.controlRef ?? activeControlRef;
    },
    status: () => load().then((session) => session.status()),
    events: (eventOptions) => (async function* () {
      const session = await load();
      yield* session.events(eventOptions);
    })(),
    result: () => load().then((session) => session.result()),
    prompt: async (turn) => {
      const session = await load();
      const result = await session.prompt(turn);
      activeControlRef = session.controlRef ?? activeControlRef;
      return result;
    },
    respondToInteraction: async (command, responseOptions) => {
      const session = await load();
      if (!session.respondToInteraction) throw new Error("cli-bridge retained interactions are not advertised");
      return session.respondToInteraction(command, responseOptions);
    },
    contextBoundary: (boundaryOptions) => load().then((session) => session.contextBoundary?.(boundaryOptions) ?? null),
    cancelRun: async (request, cancelOptions) => {
      const session = await load();
      if (!session.cancelRun) {
        throw new Error("cli-bridge retained cancellation is not advertised");
      }
      return session.cancelRun(request, cancelOptions);
    },
    cancel: () => load().then((session) => session.cancel()),
  };
}

async function* streamRetainedTurn(
  context: RetainedEnvironmentContext,
  turn: AgentTurnInput,
): AsyncIterable<AgentEnvironmentEvent> {
  rejectUnsupportedRetainedInput(turn);
  if (turn.detach) {
    await dispatchRetainedTurn(context, turn);
    return;
  }
  const state = context.state;
  const attach = !hasTurnContent(turn) &&
    (turn.lastEventId !== undefined || turn.controlRef !== undefined);
  const runId = attach
    ? await resolveRetainedRunId(context, state, turn.controlRef)
    : (await startRetainedTurn(context, turn)).id;
  yield* streamRetainedEvents(
    context,
    state,
    runId,
    turn.lastEventId,
    turn.signal,
    turn.controlRef?.requestDigest ?? state.controlRef?.requestDigest,
  );
}

async function dispatchRetainedTurn(
  context: RetainedEnvironmentContext,
  turn: AgentTurnInput,
): Promise<AgentSessionRef> {
  rejectUnsupportedRetainedInput(turn);
  const run = await startRetainedTurn(context, turn);
  const state = context.state;
  const controlRef = state.controlRef ?? makeControlRef(context.name, state.sessionId, run.id);
  state.controlRef = controlRef;
  const contextBoundary = await retainedContextBoundary(context, state);
  return {
    id: state.sessionId,
    provider: context.name,
    controlRef,
    metadata: {
      status: state.view.status,
      capabilities: state.capabilities,
      ...(state.profileReceipt ? { profileMaterializationReceipt: state.profileReceipt } : {}),
      ...(contextBoundary ? { contextBoundary } : {}),
      ...(!contextBoundary ? { contextBoundaryStatus: "unverified" } : {}),
    },
  };
}

async function startRetainedTurn(
  context: RetainedEnvironmentContext,
  turn: AgentTurnInput,
): Promise<RetainedRunSnapshot> {
  if (!hasTurnContent(turn)) {
    throw new Error("cli-bridge retained turns require a non-empty prompt or parts");
  }
  const state = context.state;
  if (turn.sessionId && turn.sessionId !== state.sessionId) {
    throw new Error("cli-bridge retained turn sessionId does not match the retained session");
  }
  if (turn.controlRef) validateControlRef(context, state, turn.controlRef);
  const publicExecutionId = turn.executionId ?? turn.turnId;
  if (!stablePublicId(publicExecutionId)) {
    throw new Error("cli-bridge retained turns require a stable executionId or turnId");
  }
  state.cancelRequested = false;
  const runId = retainedRunId(state.sessionId, publicExecutionId);
  const body: Record<string, unknown> = {
    ...(turn.prompt ? { message: turn.prompt } : {}),
    ...(turn.parts ? { parts: turn.parts } : {}),
    turn_id: turn.turnId ?? publicExecutionId,
    run_id: runId,
  };
  const response = await context.transport.fetch(
    `${trimSlash(context.options.baseUrl)}/v1/sessions/${encodeURIComponent(state.sessionId)}/turns`,
    {
      method: "POST",
      headers: requestHeaders(context.options),
      body: JSON.stringify(body),
      signal: turn.signal,
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new CliBridgeRequestRejectedError(response.status, text || "retained turn rejected");
  }
  const parsed = parseJsonText(text, "cli-bridge retained turn");
  const session = parseRetainedSessionView(parsed.session);
  if (session.id !== state.sessionId) {
    throw new Error("cli-bridge retained turn returned a different session");
  }
  const run = parseRetainedRun(parsed.run);
  if (run.id !== runId || run.sessionId !== state.sessionId) {
    throw new Error("cli-bridge retained turn returned a different run identity");
  }
  observeRetainedView(state, session, context.name);
  state.activeRun = run;
  state.controlRef = makeControlRef(
    context.name,
    state.sessionId,
    run.id,
    publicExecutionId,
    run.requestDigest,
  );
  return run;
}

async function* streamRetainedEvents(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  runId: string,
  since: string | undefined,
  signal: AbortSignal | undefined,
  expectedRequestDigest?: AgentRunControlRef["requestDigest"],
): AsyncIterable<AgentEnvironmentEvent> {
  const initialRun = await getRetainedRunStatus(
    context,
    state,
    runId,
    expectedRequestDigest,
  );
  if (!initialRun || initialRun.status === "unknown") {
    throw new CliBridgeUnknownStateError(
      `cli-bridge retained run ${JSON.stringify(runId)} is unknown`,
    );
  }
  const afterCursor = parseCursor(since);
  const controller = new AbortController();
  state.activeReaders.add(controller);
  const combinedSignal = combineSignals([signal, controller.signal]);
  let terminal = false;
  let attached = false;
  let streamError: unknown;
  try {
    const response = await context.transport.fetch(
      `${trimSlash(context.options.baseUrl)}/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        method: "GET",
        headers: {
          ...requestHeaders(context.options),
          accept: "text/event-stream",
          ...(afterCursor !== undefined ? { "last-event-id": String(afterCursor) } : {}),
        },
        signal: combinedSignal,
      },
    );
    if (!response.ok) {
      throw new CliBridgeRequestRejectedError(response.status, await response.text());
    }
    if (!response.body) throw new Error("cli-bridge retained event body is empty");
    attached = true;
    for await (const frame of parseSse(response.body)) {
      if (frame.data === "[DONE]") continue;
      const sourceEnvelope = RuntimeEventEnvelopeSchema.parse(
        parseJsonText(frame.data, "cli-bridge runtime event envelope"),
      );
      const envelope = sourceEnvelope;
      const cursor = frame.id ?? envelope.cursor;
      const numericCursor = cursor === undefined ? undefined : parseCursor(cursor);
      if (afterCursor !== undefined && numericCursor !== undefined && numericCursor <= afterCursor) {
        continue;
      }
      if (envelope.runId !== runId) {
        throw new Error("cli-bridge retained event changed its exact run identity");
      }
      const event = canonicalEnvironmentEvent(envelope, cursor);
      if (event.normalized?.type === "status" && ["completed", "failed"].includes(event.normalized.status)) {
        terminal = true;
        state.activeRun = {
          ...(state.activeRun ?? initialRun),
          id: runId,
          status: event.normalized.status === "completed" ? "done" : "error",
          terminal: true,
        };
      }
      yield event;
    }
    if (!terminal) {
      const finalRun = await getRetainedRunStatus(
        context,
        state,
        runId,
        expectedRequestDigest,
      );
      if (!finalRun || !finalRun.terminal || finalRun.status === "unknown") {
        throw new CliBridgeUnknownStateError(
          `cli-bridge retained run ${JSON.stringify(runId)} ended without a known terminal outcome`,
        );
      }
      state.activeRun = finalRun;
      terminal = true;
    }
  } catch (error) {
    streamError = error;
    throw error;
  } finally {
    state.activeReaders.delete(controller);
    if (attached && !terminal && !state.cancelRequested && !state.suppressReaderDetach) {
      try {
        await detachRetainedSession(context, state);
      } catch (detachError) {
        if (streamError) throw new AggregateError([streamError, detachError], "cli-bridge reader detach failed");
        throw detachError;
      }
    }
  }
}

async function refreshRetainedState(
  context: RetainedEnvironmentContext,
  throwOnUnknown: boolean,
): Promise<RetainedSessionView> {
  const view = await getRetainedSessionStatusView(
    context.options,
    context.transport,
    context.state.sessionId,
  );
  if (!view) {
    context.state.view = { ...context.state.view, status: "unknown" };
    context.state.activeRun = undefined;
    if (throwOnUnknown) {
      throw new CliBridgeUnknownStateError(
        `cli-bridge retained session ${JSON.stringify(context.state.sessionId)} is unknown`,
      );
    }
    return context.state.view;
  }
  observeRetainedView(context.state, view, context.name);
  return view;
}

function createRetainedSession(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  requestedControlRef?: AgentRunControlRef,
): AgentSession {
  if (requestedControlRef) validateControlRef(context, state, requestedControlRef);
  const session: AgentSession & {
    cancelOperation(options: ExactRetainedCancelOptions): Promise<{ effect: RetainedCancelEffect }>;
  } = {
    id: state.sessionId,
    get controlRef() {
      return requestedControlRef ?? state.controlRef;
    },
    status: async () => {
      if (requestedControlRef) {
        const run = await getRetainedRunStatus(
          context,
          state,
          requestedControlRef.runId,
          requestedControlRef.requestDigest,
        );
        return run ? retainedRunStatus(run) : "unknown";
      }
      const view = await refreshRetainedState(context, false);
      return retainedSessionStatus(view.status);
    },
    events: (eventOptions) => {
      const eventControlRef = (eventOptions?.executionId
        ? makeControlRef(
            context.name,
            state.sessionId,
            retainedRunId(state.sessionId, eventOptions.executionId),
            eventOptions.executionId,
          )
        : undefined) ?? requestedControlRef ?? state.controlRef;
      const runId = resolveRetainedRunIdSync(context, state, eventControlRef);
      return streamRetainedEvents(
        context,
        state,
        runId,
        eventOptions?.since,
        eventOptions?.signal,
        eventControlRef?.requestDigest,
      );
    },
    result: async (resultOptions?: { executionId?: string }) => {
      const exactRef = resultOptions?.executionId
        ? makeControlRef(
            context.name,
            state.sessionId,
            retainedRunId(state.sessionId, resultOptions.executionId),
            resultOptions.executionId,
          )
        : requestedControlRef ?? state.controlRef;
      return collectRetainedResult(context, state, exactRef);
    },
    prompt: async (turn) => {
      rejectUnsupportedRetainedInput(turn);
      const attach = !hasTurnContent(turn) &&
        (turn.lastEventId !== undefined || turn.controlRef !== undefined);
      const run = attach
        ? await resolveRetainedRunId(context, state, turn.controlRef ?? requestedControlRef ?? state.controlRef)
        : (await startRetainedTurn(context, turn)).id;
      const exactRef = turn.controlRef ??
        (state.controlRef?.runId === run ? state.controlRef : undefined) ??
        requestedControlRef ??
        makeControlRef(context.name, state.sessionId, run);
      return collectRetainedResult(context, state, exactRef, turn.lastEventId, turn.signal);
    },
    ...(state.capabilities.interactions
      ? {
          respondToInteraction: (command: InteractionResponseCommand, responseOptions?: { signal?: AbortSignal }) =>
            respondToRetainedInteraction(context, state, command, responseOptions?.signal),
        }
      : {}),
    contextBoundary: async () => retainedContextBoundary(context, state),
    cancel: async () => {
      await cancelRetainedSession(context, state, requestedControlRef ?? state.controlRef);
    },
    cancelOperation: async (options) => cancelRetainedSession(
      context,
      state,
      requestedControlRef ?? state.controlRef,
      options,
    ),
    cancelRun: async (request: AgentRunCancellationRequest, cancelOptions) => {
      const exactRequest = AgentRunCancellationRequestSchema.parse(request);
      validateControlRef(context, state, exactRequest.run);
      return sendRetainedCancellation(
        context,
        state,
        exactRequest,
        cancelOptions?.signal,
      );
    },
  };
  return session;
}

async function collectRetainedResult(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  controlRef?: AgentRunControlRef,
  since?: string,
  signal?: AbortSignal,
): Promise<AgentTurnResult> {
  const runId = await resolveRetainedRunId(context, state, controlRef);
  const events: AgentEnvironmentEvent[] = [];
  for await (const event of streamRetainedEvents(
    context,
    state,
    runId,
    since,
    signal,
    controlRef?.requestDigest,
  )) {
    events.push(event);
  }
  const exactRun = await getRetainedRunStatus(
    context,
    state,
    runId,
    controlRef?.requestDigest,
  );
  if (!exactRun) {
    throw new CliBridgeUnknownStateError(`cli-bridge retained run ${JSON.stringify(runId)} is unknown`);
  }
  const view = state.view;
  const text = textFromCanonicalEvents(events);
  const usage = events.reduce<TokenUsage | undefined>(
    (current, event) => event.usage ?? current,
    undefined,
  );
  const run = exactRun;
  const contextBoundary = contextBoundaryFromView(view, state);
  const successful = run.status === "done" && run.terminal;
  const knownFailure = run.status === "error" && run.terminal;
  const unknown = run.status === "unknown" || !run.terminal;
  const result = {
    text,
    success: successful,
    ...(successful || unknown || knownFailure ? {} : { error: `cli-bridge retained run ended ${run.status}` }),
    ...(knownFailure ? { error: "cli-bridge retained run ended error" } : {}),
    ...(unknown ? { error: "cli-bridge retained run state is unknown" } : {}),
    sessionId: state.sessionId,
    ...(usage ? { usage } : {}),
    metadata: {
      status: retainedRunStatus(run),
      runId,
      executionId: controlRef?.executionId ?? runId,
      run: run ?? null,
      capabilities: state.capabilities,
      ...(state.profileReceipt ? { profileMaterializationReceipt: state.profileReceipt } : {}),
      ...(contextBoundary ? { contextBoundary } : {}),
      ...(!contextBoundary ? { contextBoundaryStatus: "unverified" } : {}),
    },
    events,
  };
  return AgentTurnResultSchema.parse(result);
}

async function cancelRetainedSession(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  requestedControlRef?: AgentRunControlRef,
  options: ExactRetainedCancelOptions = {},
): Promise<{
  status: "accepted" | "replayed" | "conflict" | "unknown";
  effect: RetainedCancelEffect;
}> {
  const exactControlRef = await retainedControlRef(
    context,
    state,
    requestedControlRef,
  );
  if (
    options.executionId !== undefined &&
    options.executionId !== exactControlRef.executionId
  ) {
    throw new Error("cli-bridge cancellation executionId does not match the retained run");
  }
  const operationId = options.operationId ?? `cancel:${canonicalCandidateDigest({
    environmentId: RETAINED_ENVIRONMENT_ID,
    sessionId: state.sessionId,
    runId: exactControlRef.runId,
  })}`;
  const material = {
    operationId,
    run: exactControlRef,
    ...(options.reason ? { reason: options.reason } : {}),
  };
  const request = AgentRunCancellationRequestSchema.parse({
    ...material,
    requestDigest: agentRunCancellationRequestDigest(material),
  });
  const acknowledgement = await sendRetainedCancellation(
    context,
    state,
    request,
    options.signal,
  );
  return {
    status: acknowledgement.status,
    effect: acknowledgement.effect,
  };
}

async function retainedControlRef(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  requestedControlRef?: AgentRunControlRef,
): Promise<AgentRunControlRef> {
  const runId = await resolveRetainedRunId(context, state, requestedControlRef);
  const run = await getRetainedRunStatus(
    context,
    state,
    runId,
    requestedControlRef?.requestDigest,
  );
  if (!run) {
    throw new CliBridgeUnknownStateError(
      `cli-bridge retained run ${JSON.stringify(runId)} is unknown`,
    );
  }
  const executionId = requestedControlRef?.executionId ??
    (state.controlRef?.runId === runId ? state.controlRef.executionId : undefined) ??
    runId;
  return makeControlRef(
    context.name,
    state.sessionId,
    runId,
    executionId,
    run.requestDigest,
  );
}

async function sendRetainedCancellation(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  request: AgentRunCancellationRequest,
  signal?: AbortSignal,
): Promise<AgentRunCancellationAcknowledgement> {
  const exactRequest = AgentRunCancellationRequestSchema.parse(request);
  validateControlRef(context, state, exactRequest.run);
  await getRetainedRunStatus(
    context,
    state,
    exactRequest.run.runId,
    exactRequest.run.requestDigest,
  );
  const operationId = exactRequest.operationId;
  const digest = exactRequest.requestDigest;
  const existing = state.cancelOperations.get(operationId);
  if (existing) {
    if (existing.digest === digest) return existing.promise;
  }
  const operation = (async () => {
    const waitMs = Math.min(context.options.cancelWaitMs ?? 30_000, 30_000);
    const response = await context.transport.fetch(
      `${trimSlash(context.options.baseUrl)}/v1/sessions/${encodeURIComponent(state.sessionId)}/cancel?wait_ms=${waitMs}`,
      {
        method: "POST",
        headers: requestHeaders(context.options),
        body: JSON.stringify(exactRequest),
        signal,
      },
    );
    const text = await response.text();
    let acknowledgement: AgentRunCancellationAcknowledgement;
    try {
      acknowledgement = AgentRunCancellationAcknowledgementSchema.parse(
        parseJsonText(text, "cli-bridge retained cancellation acknowledgement"),
      );
    } catch (error) {
      if (!response.ok) {
        throw new CliBridgeRequestRejectedError(response.status, text || "retained cancellation rejected");
      }
      throw error;
    }
    if (!agentRunCancellationAcknowledgementMatchesRequest(exactRequest, acknowledgement)) {
      throw new Error("cli-bridge cancellation acknowledgement changed its exact request binding");
    }
    if (["accepted", "replayed"].includes(acknowledgement.status)) {
      state.cancelRequested = true;
    }
    if (acknowledgement.effect === "cancelled") {
      for (const reader of state.activeReaders) {
        reader.abort(new DOMException("cli-bridge run was explicitly cancelled", "AbortError"));
      }
    }
    return acknowledgement;
  })();
  if (!existing) state.cancelOperations.set(operationId, { digest, promise: operation });
  try {
    return await operation;
  } catch (error) {
    if (state.cancelOperations.get(operationId)?.promise === operation) {
      state.cancelOperations.delete(operationId);
    }
    throw error;
  }
}

async function detachRetainedSession(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
): Promise<void> {
  const response = await context.transport.fetch(
    `${trimSlash(context.options.baseUrl)}/v1/sessions/${encodeURIComponent(state.sessionId)}/detach`,
    { method: "POST", headers: requestHeaders(context.options), body: "{}" },
  );
  const text = await response.text();
  if (response.status === 404) {
    state.view = { ...state.view, status: "unknown" };
    throw new CliBridgeUnknownStateError(`cli-bridge retained session ${JSON.stringify(state.sessionId)} is unknown`);
  }
  if (!response.ok) throw new CliBridgeRequestRejectedError(response.status, text || "retained detach rejected");
  const parsed = parseJsonText(text, "cli-bridge retained detach");
  if (parsed.session) observeRetainedView(state, parseRetainedSessionView(parsed.session), context.name);
}

async function closeRetainedSession(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
): Promise<void> {
  const response = await context.transport.fetch(
    `${trimSlash(context.options.baseUrl)}/v1/sessions/${encodeURIComponent(state.sessionId)}/close`,
    { method: "POST", headers: requestHeaders(context.options), body: "{}" },
  );
  const text = await response.text();
  if (response.status === 404) {
    state.view = { ...state.view, status: "unknown" };
    throw new CliBridgeUnknownStateError(
      `cli-bridge retained session ${JSON.stringify(state.sessionId)} is unknown`,
    );
  }
  if (!response.ok) {
    throw new CliBridgeRequestRejectedError(
      response.status,
      text || "retained close rejected",
    );
  }
  const parsed = parseJsonText(text, "cli-bridge retained close");
  if (!parsed.session) {
    throw new Error("cli-bridge retained close omitted the exact session view");
  }
  const view = parseRetainedSessionView(parsed.session);
  if (view.id !== state.sessionId || view.status !== "closed") {
    throw new Error("cli-bridge retained close returned a mismatched session");
  }
  observeRetainedView(state, view, context.name);
}

async function respondToRetainedInteraction(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  command: InteractionResponseCommand,
  signal?: AbortSignal,
): Promise<InteractionAcknowledgement> {
  const parsed = InteractionResponseCommandSchema.parse(command);
  validateControlRef(context, state, {
    runId: parsed.binding.runId,
    provider: context.name,
    environmentId: RETAINED_ENVIRONMENT_ID,
    ...(parsed.binding.sessionId ? { sessionId: parsed.binding.sessionId } : {}),
    executionId: parsed.binding.runId,
  });
  if (parsed.binding.environmentId !== RETAINED_ENVIRONMENT_ID) {
    throw new Error("cli-bridge interaction binding has the wrong environmentId");
  }
  const transportFailure = (error: unknown): InteractionAcknowledgement =>
    InteractionAcknowledgementSchema.parse({
      operationId: parsed.operationId,
      binding: parsed.binding,
      status: "transport_failure",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  let response: CliBridgeResponse;
  try {
    response = await context.transport.fetch(
      `${trimSlash(context.options.baseUrl)}/v1/runs/${encodeURIComponent(parsed.binding.runId)}/interactions/${encodeURIComponent(parsed.binding.interactionId)}/respond`,
      {
        method: "POST",
        headers: requestHeaders(context.options),
        body: JSON.stringify(parsed),
        signal,
      },
    );
  } catch (error) {
    return transportFailure(error);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return transportFailure(error);
  }
  const body = safeJson(text);
  if (!body) {
    if (!response.ok) {
      throw new CliBridgeRequestRejectedError(response.status, text || "invalid interaction acknowledgement");
    }
    throw new Error("cli-bridge interaction acknowledgement returned invalid JSON");
  }
  const acknowledgement = InteractionAcknowledgementSchema.safeParse(body);
  if (!acknowledgement.success) {
    if (!response.ok) throw new CliBridgeRequestRejectedError(response.status, text);
    throw new Error("cli-bridge interaction acknowledgement did not match the canonical schema");
  }
  if (!interactionAcknowledgementMatchesCommand(acknowledgement.data, parsed)) {
    throw new Error("cli-bridge interaction acknowledgement did not preserve the command binding");
  }
  return acknowledgement.data;
}

function interactionAcknowledgementMatchesCommand(
  acknowledgement: InteractionAcknowledgement,
  command: InteractionResponseCommand,
): boolean {
  return acknowledgement.operationId === command.operationId &&
    acknowledgement.binding.runId === command.binding.runId &&
    acknowledgement.binding.environmentId === command.binding.environmentId &&
    acknowledgement.binding.sessionId === command.binding.sessionId &&
    acknowledgement.binding.interactionId === command.binding.interactionId;
}

async function retainedContextBoundary(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
): Promise<NativeContextBoundaryProof | null> {
  const view = await refreshRetainedState(context, false);
  return contextBoundaryFromView(view, state);
}

function contextBoundaryFromView(
  view: RetainedSessionView,
  state: RetainedSessionState,
): NativeContextBoundaryProof | null {
  if (!view.context_boundary || !view.run_id) return null;
  const proof = NativeContextBoundaryProofSchema.safeParse(view.context_boundary);
  if (!proof.success) return null;
  if (
    proof.data.runId !== view.run_id ||
    proof.data.environmentId !== RETAINED_ENVIRONMENT_ID ||
    proof.data.sessionId !== state.sessionId
  ) return null;
  return proof.data;
}

function validateControlRef(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  value: AgentRunControlRef,
): void {
  const controlRef = AgentRunControlRefSchema.parse(value);
  if (
    controlRef.provider !== context.name ||
    controlRef.environmentId !== RETAINED_ENVIRONMENT_ID ||
    (controlRef.sessionId !== undefined && controlRef.sessionId !== state.sessionId)
  ) {
    throw new Error("cli-bridge controlRef does not bind to this retained session");
  }
}

async function resolveRetainedRunId(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  controlRef?: AgentRunControlRef,
): Promise<string> {
  if (controlRef) {
    validateControlRef(context, state, controlRef);
    const run = await getRetainedRunStatus(
      context,
      state,
      controlRef.runId,
      controlRef.requestDigest,
    );
    if (!run) throw new CliBridgeUnknownStateError("cli-bridge retained run is unknown");
    return controlRef.runId;
  }
  const view = await refreshRetainedState(context, true);
  const runId = state.controlRef?.runId ?? view.run_id;
  if (!runId) throw new CliBridgeUnknownStateError("cli-bridge retained session has no admitted run");
  return runId;
}

function resolveRetainedRunIdSync(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  controlRef?: AgentRunControlRef,
): string {
  if (controlRef) validateControlRef(context, state, controlRef);
  const runId = controlRef?.runId ?? state.controlRef?.runId ?? state.view.run_id;
  if (!runId) throw new CliBridgeUnknownStateError("cli-bridge retained session has no admitted run");
  return runId;
}

function rejectUnsupportedRetainedInput(turn: AgentTurnInput): void {
  if (turn.contextTransfer) throw new Error("cli-bridge retained sessions do not advertise portable context transfer");
  if (turn.nativeContinuation) throw new Error("cli-bridge retained sessions do not advertise native continuation");
}

function hasTurnContent(turn: AgentTurnInput): boolean {
  return (typeof turn.prompt === "string" && turn.prompt.length > 0) ||
    (Array.isArray(turn.parts) && turn.parts.length > 0);
}

function snapshotInlineProfile(profile: AgentProfileRef): AgentProfile | undefined {
  return typeof profile === "string" ? undefined : snapshotAgentProfile(profile);
}

function tryResolveBridgeModel(
  options: CliBridgeProviderOptions,
  input: CreateAgentEnvironmentInput,
  profile: AgentProfile | undefined,
): string | undefined {
  try {
    return resolveBridgeModel(options, input, {}, profile);
  } catch {
    return undefined;
  }
}

function parseRetainedSessionView(value: unknown): RetainedSessionView {
  if (!value || typeof value !== "object") throw new Error("cli-bridge retained session returned an invalid view");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !sha256DigestSchema.safeParse(record.create_request_digest).success ||
    (record.object !== undefined && record.object !== "session") ||
    typeof record.backend !== "string" ||
    typeof record.model !== "string" ||
    typeof record.status !== "string" ||
    !["created", "idle", "running", "completed", "cancelled", "closed", "unknown"].includes(record.status) ||
    (record.run_id !== null && typeof record.run_id !== "string") ||
    (record.internal_session_id !== null && typeof record.internal_session_id !== "string") ||
    typeof record.turns !== "number" ||
    !Number.isInteger(record.turns) ||
    !Array.isArray(record.capabilities) && (!record.capabilities || typeof record.capabilities !== "object")
  ) {
    throw new Error("cli-bridge retained session returned an invalid view");
  }
  const run = record.run === undefined || record.run === null ? undefined : parseRetainedRun(record.run);
  if (
    run &&
    (run.sessionId !== record.id ||
      (record.run_id !== null && run.id !== record.run_id))
  ) {
    throw new Error("cli-bridge retained session returned a mismatched run binding");
  }
  const receipt = record.profile_materialization_receipt;
  if (receipt !== null && (receipt === undefined || typeof receipt !== "object" || Array.isArray(receipt))) {
    throw new Error("cli-bridge retained session returned an invalid profile receipt");
  }
  const boundary = record.context_boundary;
  if (boundary !== null && (boundary === undefined || typeof boundary !== "object" || Array.isArray(boundary))) {
    throw new Error("cli-bridge retained session returned an invalid context boundary");
  }
  return {
    id: record.id,
    create_request_digest: record.create_request_digest as `sha256:${string}`,
    backend: record.backend,
    model: record.model,
    status: record.status as RetainedStatus,
    run_id: record.run_id as string | null,
    internal_session_id: record.internal_session_id as string | null,
    turns: record.turns,
    capabilities: AgentEnvironmentCapabilitiesSchema.parse(record.capabilities),
    profile_materialization_receipt: receipt as Record<string, unknown> | null,
    context_boundary: boundary as Record<string, unknown> | null,
    ...(run ? { run } : {}),
  };
}

function parseRetainedRun(value: unknown): RetainedRunSnapshot {
  if (!value || typeof value !== "object") throw new Error("cli-bridge retained session returned an invalid run");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !sha256DigestSchema.safeParse(record.requestDigest).success ||
    !["running", "done", "error", "cancelled", "unknown"].includes(String(record.status)) ||
    typeof record.terminal !== "boolean" ||
    typeof record.sessionId !== "string"
  ) {
    throw new Error("cli-bridge retained session returned an invalid run");
  }
  return record as RetainedRunSnapshot;
}

async function getRetainedSessionView(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  id: string,
): Promise<RetainedSessionView | null> {
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/sessions/${encodeURIComponent(id)}`,
    { method: "GET", headers: requestHeaders(options) },
  );
  if (response.status === 404 || response.status === 405 || response.status === 501) return null;
  if (!response.ok) throw new CliBridgeRequestRejectedError(response.status, await response.text());
  return parseRetainedSessionView(parseJsonText(await response.text(), "cli-bridge retained session view"));
}

async function getRetainedSessionStatusView(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  id: string,
): Promise<RetainedSessionView | null> {
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/sessions/${encodeURIComponent(id)}/status`,
    { method: "GET", headers: requestHeaders(options) },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new CliBridgeRequestRejectedError(response.status, await response.text());
  return parseRetainedSessionView(parseJsonText(await response.text(), "cli-bridge retained session status"));
}

async function getRetainedRunStatus(
  context: RetainedEnvironmentContext,
  state: RetainedSessionState,
  runId: string,
  expectedRequestDigest?: AgentRunControlRef["requestDigest"],
): Promise<RetainedRunSnapshot | null> {
  const response = await context.transport.fetch(
    `${trimSlash(context.options.baseUrl)}/v1/runs/${encodeURIComponent(runId)}`,
    { method: "GET", headers: requestHeaders(context.options) },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new CliBridgeRequestRejectedError(response.status, await response.text());
  }
  const run = parseRetainedRun(
    parseJsonText(await response.text(), "cli-bridge retained run status"),
  );
  if (run.id !== runId || run.sessionId !== state.sessionId) {
    throw new Error("cli-bridge retained run status does not bind to this session");
  }
  if (
    expectedRequestDigest !== undefined &&
    run.requestDigest !== expectedRequestDigest
  ) {
    throw new Error("cli-bridge retained run changed its exact request digest");
  }
  state.activeRun = run;
  if (state.controlRef?.runId === runId) {
    state.controlRef = makeControlRef(
      context.name,
      state.sessionId,
      runId,
      state.controlRef.executionId,
      run.requestDigest,
    );
  }
  return run;
}

function canonicalEnvironmentEvent(
  envelope: RuntimeEventEnvelope,
  replayCursor?: string,
): AgentEnvironmentEvent {
  const event = envelope.event;
  const data = { ...(event as unknown as Record<string, unknown>) };
  return {
    type: event.type,
    data,
    id: replayCursor ?? envelope.cursor ?? envelope.eventId,
    normalized: event,
    providerEvent: envelope,
    ...(usageFromCanonicalEvent(event) ? { usage: usageFromCanonicalEvent(event) } : {}),
  };
}

function usageFromCanonicalEvent(event: StreamEvent): TokenUsage | undefined {
  if (event.type !== "raw" || !event.event || typeof event.event !== "object") return undefined;
  const raw = event.event as Record<string, unknown>;
  const usage = raw.usage ?? (raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>).usage : undefined);
  return usageFromUsageRecord(usage);
}

function usageFromUsageRecord(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = number(record.inputTokens) ?? number(record.input_tokens) ?? number(record.prompt_tokens);
  const outputTokens = number(record.outputTokens) ?? number(record.output_tokens) ?? number(record.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const totalTokens = number(record.totalTokens) ?? number(record.total_tokens);
  const cacheReadInputTokens = number(record.cacheReadInputTokens) ?? number(record.cache_read_input_tokens);
  const cacheCreationInputTokens = number(record.cacheCreationInputTokens) ?? number(record.cache_creation_input_tokens);
  const reasoningTokens = number(record.reasoningTokens) ?? number(record.reasoning_tokens);
  const cost = number(record.cost);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

function textFromCanonicalEvents(events: readonly AgentEnvironmentEvent[]): string {
  const parts = new Map<string, string>();
  for (const event of events) {
    const normalized = event.normalized;
    if (normalized?.type !== "message.part.updated" || normalized.part.type !== "text") continue;
    parts.set(normalized.part.id, normalized.part.text);
  }
  return Array.from(parts.values()).join("");
}

function retainedEnvironmentStatus(status: RetainedStatus): "pending" | "running" | "stopped" | "unknown" {
  if (status === "created") return "pending";
  if (status === "unknown") return "unknown";
  if (status === "closed" || status === "cancelled") return "stopped";
  return "running";
}

function retainedSessionStatus(status: RetainedStatus): AgentSessionStatus {
  if (status === "created") return "pending";
  if (status === "running") return "running";
  if (status === "cancelled") return "cancelled";
  if (status === "closed") return "stopped";
  if (status === "unknown") return "unknown";
  return "completed";
}

function retainedRunStatus(run: RetainedRunSnapshot): AgentSessionStatus {
  if (run.status === "running") return "running";
  if (run.status === "done") return "completed";
  if (run.status === "error") return "failed";
  if (run.status === "cancelled") return "cancelled";
  return "unknown";
}

function parseCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/u.test(value)) throw new Error(`cli-bridge event cursor must be a non-negative integer: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("cli-bridge event cursor exceeds the safe integer range");
  return parsed;
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function frozenRecord(value: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(value) as Record<string, unknown>;
  return deepFreezeRecord(clone);
}

function deepFreezeRecord<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeRecord(child, seen);
  return Object.freeze(value);
}

function isRetainedUnsupported(
  status: number,
  text: string,
  headers?: { get(name: string): string | null },
): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  if (headers?.get("content-type")?.includes("text/event-stream")) return true;
  const body = safeJson(text);
  return status === 400 && body?.error !== undefined && typeof body.error === "object" &&
    (body.error as Record<string, unknown>).type === "capability_denied";
}

function parseJsonText(value: string, label: string): Record<string, unknown> {
  const parsed = safeJson(value);
  if (!parsed) throw new Error(`${label} returned invalid JSON`);
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CliBridgeUnknownStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliBridgeUnknownStateError";
  }
}

interface CliBridgeRun {
  readonly id: string;
  readonly readers: Set<AbortController>;
  cancellation?: Promise<CliBridgeRunSnapshot>;
}

interface CliBridgeRunSnapshot {
  readonly id: string;
  readonly status: "running" | "done" | "error" | "cancelled";
  readonly terminal: boolean;
}

async function* streamTrackedCliBridgeTurn(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  originalTurn: AgentTurnInput,
  transport: CliBridgeTransport,
  environmentId: string,
  runs: Map<string, CliBridgeRun>,
  readers: Set<AbortController>,
): AsyncIterable<AgentEnvironmentEvent> {
  if (originalTurn.detach) {
    throw new Error("cli-bridge provider does not support detached turns");
  }
  const sessionId = originalTurn.sessionId;
  const turnId = originalTurn.turnId ?? crypto.randomUUID();
  const runId = cliBridgeRunId(environmentId, originalTurn, turnId);
  const controller = new AbortController();
  const signals = [
    originalTurn.signal,
    environmentInput.signal,
    controller.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const turn = {
    ...originalTurn,
    turnId,
    ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
  };
  const requestBody = JSON.stringify(
    toChatCompletionsBody(options, environmentInput, turn, runId),
  );
  const run = runs.get(runId) ?? {
    id: runId,
    readers: new Set<AbortController>(),
  };
  run.readers.add(controller);
  readers.add(controller);
  runs.set(runId, run);

  let drained = false;
  let threw = false;
  try {
    for await (const event of streamCliBridgeTurn(
      options,
      turn,
      requestBody,
      transport,
      runId,
      originalTurn.lastEventId,
      signals.length > 0 ? AbortSignal.any(signals) : undefined,
    )) {
      yield event;
    }
    drained = true;
    if (runs.get(run.id) === run) runs.delete(run.id);
  } catch (error) {
    threw = true;
    if (error instanceof CliBridgeRequestRejectedError) {
      if (runs.get(run.id) === run) runs.delete(run.id);
      throw error;
    }
    let snapshot: CliBridgeRunSnapshot | null | undefined;
    try {
      snapshot = await getCliBridgeRun(options, transport, run.id);
    } catch {
      snapshot = undefined;
    }
    if (snapshot?.terminal) {
      if (runs.get(run.id) === run) runs.delete(run.id);
    } else if (
      (originalTurn.signal?.aborted || environmentInput.signal?.aborted)
    ) {
      await cancelCliBridgeRun(options, transport, run);
      if (runs.get(run.id) === run) runs.delete(run.id);
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

async function cancelCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
): Promise<CliBridgeRunSnapshot> {
  if (run.cancellation) return run.cancellation;
  run.cancellation = (async () => {
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
    const waitBudgetMs = options.cancelWaitMs ?? 30_000;
    const deadline = Date.now() + waitBudgetMs;
    while (!snapshot.terminal) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      snapshot = await getCliBridgeRun(
        options,
        transport,
        run.id,
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
  })();
  try {
    return await run.cancellation;
  } finally {
    run.cancellation = undefined;
  }
}

async function getCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  runId: string,
  waitMs?: number,
): Promise<CliBridgeRunSnapshot | null> {
  const query = waitMs === undefined ? "" : `?wait_ms=${waitMs}`;
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(runId)}${query}`,
    {
      method: "GET",
      headers: requestHeaders(options),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`cli-bridge run status ${response.status}: ${await response.text()}`);
  }
  return runSnapshot(await response.text());
}

async function* streamCliBridgeTurn(
  options: CliBridgeProviderOptions,
  turn: AgentTurnInput,
  requestBody: string,
  transport: CliBridgeTransport,
  runId: string,
  lastEventId?: string,
  signal?: AbortSignal,
): AsyncIterable<AgentEnvironmentEvent> {
  const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...requestHeaders(options),
      accept: "text/event-stream",
      ...(turn.sessionId ? { "x-session-id": turn.sessionId } : {}),
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
    body: requestBody,
    signal,
  });
  if (!response.ok) {
    let detail = "request rejected";
    try {
      detail = await response.text();
    } catch {
      // The HTTP status already proves this request was rejected.
    }
    throw new CliBridgeRequestRejectedError(response.status, detail);
  }
  if (!response.body) throw new Error("cli-bridge response body is empty");

  let text = "";
  const sessionId = turn.sessionId ?? runId;
  const messageId = turn.turnId ?? `${sessionId}:assistant`;
  const emittedToolCalls = new Set<string>();
  let completed = false;
  let terminalCursor: string | undefined;
  for await (const frame of parseSse(response.body)) {
    if (frame.data === "[DONE]") continue;
    const parsed = safeJson(frame.data);
    if (!parsed) continue;
    if (parsed.error && typeof parsed.error === "object") {
      const error = parsed.error as Record<string, unknown>;
      const message = typeof error.message === "string" ? error.message : "cli-bridge error";
      yield {
        type: "status",
        data: { status: "failed", error: message },
        ...(frame.id ? { id: frame.id } : {}),
      };
      throw new Error(`cli-bridge: ${message}`);
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    const delta = choice?.delta;
    const chunk = delta && typeof delta.content === "string" ? delta.content : "";
    const nextUsage = usageFromOpenAi(parsed.usage);
    const frameEvents: AgentEnvironmentEvent[] = [];
    if (nextUsage) {
      frameEvents.push({ type: "usage", data: {}, usage: nextUsage });
    }
    if (chunk) {
      text += chunk;
      const part: TextPart = {
        id: `${messageId}:text`,
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text,
      };
      const normalized: MessagePartUpdatedEvent = {
        type: "message.part.updated",
        part,
        delta: chunk,
      };
      frameEvents.push({
        type: "message.part.updated",
        data: { part, delta: chunk },
        normalized,
      });
    }
    for (const toolCall of toolCallsFromDelta(delta)) {
      const callId = toolCall.id ?? `${messageId}:tool:${toolCall.index}`;
      if (!toolCall.name || emittedToolCalls.has(callId)) continue;
      emittedToolCalls.add(callId);
      const part: ToolPart = {
        id: callId,
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        callID: callId,
        tool: toolCall.name,
        state: { status: "pending", input: {} },
      };
      const normalized: MessagePartUpdatedEvent = {
        type: "message.part.updated",
        part,
      };
      frameEvents.push({
        type: "message.part.updated",
        data: { part },
        normalized,
      });
    }
    if (choice?.finish_reason) {
      if (choice.finish_reason === "error") {
        frameEvents.push({
          type: "status",
          data: { status: "failed", error: "cli-bridge returned finish_reason=error" },
        });
        yield* eventsWithCursor(frameEvents, frame.id);
        throw new Error("cli-bridge returned finish_reason=error");
      }
      completed = true;
      if (lastEventId) {
        terminalCursor = frame.id;
      } else {
        frameEvents.push({
          type: "result",
          data: {
            finalText: text,
            finishReason: choice.finish_reason,
            status: "completed",
          },
        });
      }
    }
    yield* eventsWithCursor(
      frameEvents,
      choice?.finish_reason && lastEventId ? undefined : frame.id,
    );
  }
  if (!completed && !lastEventId) {
    throw new Error("cli-bridge stream ended without a terminal result");
  }
  if (lastEventId) {
    const result = await readFullCliBridgeResult(
      options,
      requestBody,
      transport,
      signal,
    );
    yield {
      type: "result",
      data: {
        finalText: result.text,
        finishReason: result.finishReason,
        status: "completed",
      },
      id: terminalCursor ?? lastEventId,
    };
  }
}

class CliBridgeRequestRejectedError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`cli-bridge ${status}: ${detail}`);
    this.name = "CliBridgeRequestRejectedError";
  }
}

async function readFullCliBridgeResult(
  options: CliBridgeProviderOptions,
  requestBody: string,
  transport: CliBridgeTransport,
  signal?: AbortSignal,
): Promise<{ text: string; finishReason: string }> {
  const body = safeJson(requestBody);
  if (!body) throw new Error("cli-bridge replay request is not valid JSON");
  const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/chat/completions`, {
    method: "POST",
    headers: requestHeaders(options),
    body: JSON.stringify({ ...body, stream: false }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`cli-bridge replay result ${response.status}: ${await response.text()}`);
  }
  const parsed = safeJson(await response.text());
  if (parsed?.error && typeof parsed.error === "object") {
    const error = parsed.error as Record<string, unknown>;
    const message =
      typeof error.message === "string" ? error.message : "cli-bridge replay failed";
    throw new Error(`cli-bridge replay result failed: ${message}`);
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
  const message =
    choice?.message && typeof choice.message === "object"
      ? choice.message as Record<string, unknown>
      : undefined;
  if (
    typeof message?.content !== "string" ||
    typeof choice?.finish_reason !== "string"
  ) {
    throw new Error("cli-bridge replay result returned an invalid completion");
  }
  if (choice.finish_reason === "error" || choice.finish_reason === "timeout") {
    throw new Error(`cli-bridge replay result ended ${choice.finish_reason}`);
  }
  return { text: message.content, finishReason: choice.finish_reason };
}

interface CliBridgeTransport {
  fetch(input: string, init: CliBridgeRequest): Promise<CliBridgeResponse>;
  close(): Promise<void>;
}

interface CliBridgeRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

interface CliBridgeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
}

function createTransport(options: CliBridgeProviderOptions): CliBridgeTransport {
  if (options.fetch) {
    const fetch = options.fetch;
    return {
      fetch: (input, init) => fetch(input, init),
      close: async () => {},
    };
  }
  const dispatcher = new Agent({
    headersTimeout: options.headersTimeoutMs ?? 0,
    bodyTimeout: options.bodyTimeoutMs ?? 0,
  });
  return {
    fetch: (input, init) =>
      undiciFetch(input, {
        ...init,
        dispatcher,
      }),
    close: async () => {
      await dispatcher.close();
    },
  };
}

function assertTimeout(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`createCliBridgeProvider ${name} must be a non-negative integer`);
  }
}

function toChatCompletionsBody(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  runId: string,
): Record<string, unknown> {
  const profile = inlineProfile(environmentInput.profile);
  return {
    model: resolveBridgeModel(options, environmentInput, turn, profile),
    messages: messagesFromTurn(turn, profile),
    stream: true,
    ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
    run_id: runId,
    ...(options.defaultMode ? { mode: options.defaultMode } : {}),
    ...(profile ? { agent_profile: profile } : {}),
    ...(environmentInput.env ? { env: environmentInput.env } : {}),
    ...(environmentInput.workspace?.cwd ? { cwd: environmentInput.workspace.cwd } : {}),
    ...(executionFromInput(options, environmentInput) ? { execution: executionFromInput(options, environmentInput) } : {}),
    metadata: {
      ...(environmentInput.metadata ?? {}),
      ...(turn.context ?? {}),
      ...(turn.providerOptions ?? {}),
    },
  };
}

function resolveBridgeModel(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  profile: AgentProfile | undefined,
): string {
  const harness = environmentInput.backend ?? profile?.harness;
  const model = turn.model ?? options.defaultModel ?? profile?.model?.default;
  const provider = profile?.model?.provider;
  if (!harness) {
    if (model) return model;
    throw new Error(
      "createCliBridgeProvider requires an explicit bridge model or a profile/backend harness",
    );
  }
  if (!model || model === harness) return harness;
  if (model.startsWith(`${harness}/`)) return model;
  if (model.includes("/")) return `${harness}/${model}`;
  if (provider) return `${harness}/${provider}/${model}`;
  return `${harness}/${model}`;
}

function messagesFromTurn(turn: AgentTurnInput, profile: AgentProfile | undefined): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const systemPrompt = profile?.prompt?.systemPrompt;
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: contentFromTurn(turn) });
  return messages;
}

function contentFromTurn(turn: AgentTurnInput): string | InputPart[] {
  if (turn.parts) return turn.parts;
  return turn.prompt ?? "";
}

function inlineProfile(profile: AgentProfileRef): AgentProfile | undefined {
  return typeof profile === "string" ? undefined : profile;
}

function executionFromInput(
  options: CliBridgeProviderOptions,
  input: CreateAgentEnvironmentInput,
): CliBridgeProviderOptions["defaultExecution"] | undefined {
  if (options.defaultExecution) return options.defaultExecution;
  if (!input.workspace?.repoUrl) return undefined;
  return {
    kind: "sandbox",
    repoUrl: input.workspace.repoUrl,
    ...(input.workspace.gitRef ? { gitRef: input.workspace.gitRef } : {}),
  };
}

interface CliBridgeSseFrame {
  readonly data: string;
  readonly id?: string;
}

async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncIterable<CliBridgeSseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const value of body) {
    buffer += decoder.decode(value, { stream: true });
    let boundary = findFrameBoundary(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const data = dataFromFrame(frame);
      if (data) yield data;
      boundary = findFrameBoundary(buffer);
    }
  }
  if (buffer) {
    const data = dataFromFrame(buffer);
    if (data) yield data;
  }
}

function findFrameBoundary(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function dataFromFrame(frame: string): CliBridgeSseFrame | undefined {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return undefined;
  const id = lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim();
  return { data, ...(id ? { id } : {}) };
}

function* eventsWithCursor(
  events: readonly AgentEnvironmentEvent[],
  cursor?: string,
): Iterable<AgentEnvironmentEvent> {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    yield cursor && index === events.length - 1 ? { ...event, id: cursor } : event;
  }
}

function toolCallsFromDelta(value: unknown): Array<{ id?: string; index: number; name?: string }> {
  if (!value || typeof value !== "object") return [];
  const calls = (value as Record<string, unknown>).tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call, position) => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const fn = record.function;
    const name =
      fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string"
        ? ((fn as Record<string, unknown>).name as string)
        : undefined;
    const index = number(record.index) ?? position;
    const id = typeof record.id === "string" ? record.id : undefined;
    return [{ ...(id ? { id } : {}), index, ...(name ? { name } : {}) }];
  });
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function usageFromOpenAi(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = number(record.prompt_tokens) ?? number(record.input_tokens);
  const outputTokens = number(record.completion_tokens) ?? number(record.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const totalTokens = number(record.total_tokens);
  const cacheReadInputTokens = number(record.cache_read_input_tokens);
  const cacheCreationInputTokens = number(record.cache_creation_input_tokens);
  const reasoningTokens = number(record.reasoning_tokens);
  const cost = number(record.cost);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

function requestHeaders(options: CliBridgeProviderOptions): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
  };
}

function cliBridgeRunId(
  environmentId: string,
  turn: AgentTurnInput,
  turnId: string,
): string {
  if (
    turn.executionId &&
    turn.executionId.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(turn.executionId)
  ) {
    return turn.executionId;
  }
  const digest = createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(turn.sessionId ?? "")
    .update("\0")
    .update(turn.executionId ?? turnId)
    .digest("hex");
  return `agent-${digest}`;
}

function retainedRunId(
  sessionId: string,
  executionId: string,
): string {
  const digest = createHash("sha256")
    .update(RETAINED_ENVIRONMENT_ID)
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(executionId)
    .digest("hex");
  return `agent-${digest}`;
}

function stablePublicId(value: string | undefined): value is string {
  return value !== undefined &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value;
}

function runSnapshot(value: string): CliBridgeRunSnapshot {
  const parsed = safeJson(value);
  if (!parsed) throw new Error("cli-bridge run status returned invalid JSON");
  const id = parsed.id;
  const status = parsed.status;
  const terminal = parsed.terminal;
  if (
    typeof id !== "string" ||
    !["running", "done", "error", "cancelled"].includes(String(status)) ||
    typeof terminal !== "boolean"
  ) {
    throw new Error("cli-bridge run status returned an invalid snapshot");
  }
  return {
    id,
    status: status as CliBridgeRunSnapshot["status"],
    terminal,
  };
}

function cancelSnapshot(value: string): CliBridgeRunSnapshot {
  const parsed = safeJson(value);
  if (!parsed || !parsed.run || typeof parsed.run !== "object") {
    throw new Error("cli-bridge cancel returned an invalid snapshot");
  }
  return runSnapshot(JSON.stringify(parsed.run));
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
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
    streaming: { live: true, replay: false, detach: false, turnIdempotency: false },
    sessions: { continue: false, list: false, messages: false },
    workspace: { read: false, write: false, exec: false, git: false, upload: false, download: false },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: true,
    confidential: false,
  };
}
