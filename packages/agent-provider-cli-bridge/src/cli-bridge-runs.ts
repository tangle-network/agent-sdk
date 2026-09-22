import { createHash } from "node:crypto";
import type {
  AgentProfile,
  AgentProfileRef,
  InputPart,
} from "@tangle-network/agent-interface";
import type {
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  CliBridgeProviderOptions,
  CliBridgeRun,
  CliBridgeSessionState,
  PreparedCliBridgeRun,
} from "./cli-bridge-types.js";

export function prepareCliBridgeRun(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  originalTurn: AgentTurnInput,
  environmentId: string,
  requireSession: boolean,
): PreparedCliBridgeRun {
  const turnId = originalTurn.turnId ?? crypto.randomUUID();
  const runId = cliBridgeRunId(environmentId, originalTurn, turnId);
  const sessionId = resolveSessionId(originalTurn.sessionId, requireSession, runId);
  const turn = {
    ...originalTurn,
    turnId,
    ...(sessionId ? { sessionId } : {}),
  };
  return {
    turn,
    run: {
      id: runId,
      ...(sessionId ? { sessionId } : {}),
      turnId,
      requestBody: JSON.stringify(
        toChatCompletionsBody(options, environmentInput, turn, runId),
      ),
      readers: new Set<AbortController>(),
    },
  };
}

function resolveSessionId(
  value: string | undefined,
  requireSession: boolean,
  generatedId: string,
): string | undefined {
  if (value === undefined) return requireSession ? generatedId : undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("cli-bridge sessionId must be a non-blank string");
  }
  return value;
}

export function bindCliBridgeRun(
  run: CliBridgeRun,
  runs: Map<string, CliBridgeRun>,
): CliBridgeRun | undefined {
  const previous = runs.get(run.id);
  runs.set(run.id, run);
  return previous;
}

export function restoreCliBridgeRun(
  run: CliBridgeRun,
  previous: CliBridgeRun | undefined,
  runs: Map<string, CliBridgeRun>,
): void {
  if (runs.get(run.id) !== run) return;
  if (previous) {
    runs.set(run.id, previous);
  } else {
    runs.delete(run.id);
  }
}

export function bindCliBridgeSession(
  run: CliBridgeRun,
  sessions: Map<string, CliBridgeSessionState>,
): CliBridgeRun | undefined {
  if (!run.sessionId) return undefined;
  const previous = sessions.get(run.sessionId)?.current;
  run.sessionPrevious = previous;
  sessions.set(run.sessionId, { id: run.sessionId, current: run });
  return previous;
}

export function restoreCliBridgeSession(
  run: CliBridgeRun,
  previous: CliBridgeRun | undefined,
  sessions: Map<string, CliBridgeSessionState>,
): void {
  run.settled = true;
  if (!run.sessionId || sessions.get(run.sessionId)?.current !== run) return;
  const replacement =
    findActiveSessionPredecessor(run, previous) ??
    findAcceptedSessionPredecessor(run, previous);
  if (replacement) {
    sessions.set(run.sessionId, { id: run.sessionId, current: replacement });
  } else {
    sessions.delete(run.sessionId);
  }
  run.sessionPrevious = undefined;
}

/** Keep a still-active predecessor current, without letting an older run win later. */
export function settleCliBridgeSession(
  run: CliBridgeRun,
  previous: CliBridgeRun | undefined,
  sessions: Map<string, CliBridgeSessionState>,
): void {
  run.settled = true;
  if (!run.sessionId || sessions.get(run.sessionId)?.current !== run) return;
  const replacement = findActiveSessionPredecessor(run, previous);
  if (replacement) {
    sessions.set(run.sessionId, { id: run.sessionId, current: replacement });
  }
  run.sessionPrevious = undefined;
}

function findActiveSessionPredecessor(
  run: CliBridgeRun,
  fallback: CliBridgeRun | undefined,
): CliBridgeRun | undefined {
  const visited = new Set<CliBridgeRun>();
  let candidate = run.sessionPrevious ?? fallback;
  while (candidate && candidate.settled) {
    if (visited.has(candidate)) return undefined;
    visited.add(candidate);
    candidate = candidate.sessionPrevious;
  }
  return candidate;
}

function findAcceptedSessionPredecessor(
  run: CliBridgeRun,
  fallback: CliBridgeRun | undefined,
): CliBridgeRun | undefined {
  const visited = new Set<CliBridgeRun>();
  let candidate = run.sessionPrevious ?? fallback;
  while (candidate) {
    if (visited.has(candidate)) return undefined;
    visited.add(candidate);
    if (candidate.accepted) return candidate;
    candidate = candidate.sessionPrevious;
  }
  return undefined;
}

export function cliBridgeRunId(
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

function toChatCompletionsBody(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  runId: string,
): Record<string, unknown> {
  const profile = inlineProfile(environmentInput.profile);
  const execution = executionFromInput(options, environmentInput);
  return {
    model: resolveBridgeModel(options, environmentInput, turn, profile),
    messages: messagesFromTurn(turn),
    stream: true,
    ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
    run_id: runId,
    ...(options.defaultMode ? { mode: options.defaultMode } : {}),
    ...(profile ? { agent_profile: profile } : {}),
    ...(profile?.model?.reasoningEffort
      ? { effort: profile.model.reasoningEffort }
      : {}),
    ...(environmentInput.env ? { env: environmentInput.env } : {}),
    ...(environmentInput.workspace?.cwd
      ? { cwd: environmentInput.workspace.cwd }
      : {}),
    ...(execution ? { execution } : {}),
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

function messagesFromTurn(turn: AgentTurnInput): Array<Record<string, unknown>> {
  return [{ role: "user", content: contentFromTurn(turn) }];
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
