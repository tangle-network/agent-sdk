import {
  AgentExactRunControlRefSchema,
  type AgentExactRunControlRef,
  type AgentRunControlRef,
  type Sha256Digest,
} from "@tangle-network/agent-interface";
import type {
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import { cliBridgeRunId, toChatCompletionsBody } from "./wire.js";

export interface CliBridgeRun {
  readonly id: string;
  readonly environmentId: string;
  readonly sessionId?: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly requestBody: string;
  readonly readers: Set<AbortController>;
  requestDigest?: Sha256Digest;
  controlRef?: AgentExactRunControlRef;
  cancellation?: Promise<CliBridgeRunSnapshot>;
}

export interface CliBridgeSessionState {
  readonly id: string;
  current: CliBridgeRun;
}

export interface CliBridgeRunSnapshot {
  readonly id: string;
  readonly requestDigest?: Sha256Digest;
  readonly status: "running" | "done" | "error" | "cancelled" | "unknown";
  readonly terminal: boolean;
}

export interface PreparedCliBridgeRun {
  readonly run: CliBridgeRun;
  readonly turn: AgentTurnInput;
}

export function exactControlRefForRun(
  run: CliBridgeRun,
  providerName: string,
): AgentExactRunControlRef {
  if (!run.sessionId || !run.requestDigest) {
    throw new Error("cli-bridge did not return complete retained run coordinates");
  }
  return Object.freeze(AgentExactRunControlRefSchema.parse({
    runId: run.id,
    provider: providerName,
    environmentId: run.environmentId,
    sessionId: run.sessionId,
    executionId: run.executionId,
    requestDigest: run.requestDigest,
  }));
}

export function exactControlRefForSession(
  value: AgentRunControlRef,
  providerName: string,
  environmentId: string,
  sessionId: string,
): AgentExactRunControlRef {
  const controlRef = Object.freeze(AgentExactRunControlRefSchema.parse(value));
  if (
    controlRef.provider !== providerName ||
    controlRef.environmentId !== environmentId ||
    controlRef.sessionId !== sessionId
  ) {
    throw new Error("cli-bridge control reference does not bind to this session");
  }
  return controlRef;
}

export function runFromControlRef(controlRef: AgentExactRunControlRef): CliBridgeRun {
  return {
    id: controlRef.runId,
    environmentId: controlRef.environmentId,
    sessionId: controlRef.sessionId,
    executionId: controlRef.executionId,
    turnId: controlRef.executionId,
    requestBody: "",
    readers: new Set<AbortController>(),
    requestDigest: controlRef.requestDigest,
    controlRef,
  };
}

export function assertRunMatchesControlRef(
  run: CliBridgeRun,
  controlRef: AgentExactRunControlRef,
): void {
  if (
    run.id !== controlRef.runId ||
    run.environmentId !== controlRef.environmentId ||
    run.sessionId !== controlRef.sessionId ||
    run.executionId !== controlRef.executionId ||
    run.requestDigest !== controlRef.requestDigest
  ) {
    throw new Error("cli-bridge control reference conflicts with the retained run");
  }
  run.controlRef = controlRef;
}

export function prepareCliBridgeRun(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  originalTurn: AgentTurnInput,
  environmentId: string,
  requireSession: boolean,
): PreparedCliBridgeRun {
  if (
    requireSession &&
    (originalTurn.turnId === undefined || originalTurn.executionId === undefined)
  ) {
    throw new Error(
      "cli-bridge native retained turns require stable turnId and executionId values",
    );
  }
  const turnId = originalTurn.turnId ?? crypto.randomUUID();
  const runId = cliBridgeRunId(environmentId, originalTurn, turnId);
  const sessionId = originalTurn.sessionId ?? (requireSession ? runId : undefined);
  const turn = {
    ...originalTurn,
    turnId,
    ...(sessionId ? { sessionId } : {}),
  };
  return {
    turn,
    run: {
      id: runId,
      environmentId,
      ...(sessionId ? { sessionId } : {}),
      executionId: originalTurn.executionId ?? runId,
      turnId,
      requestBody: JSON.stringify(
        toChatCompletionsBody(options, environmentInput, turn, runId),
      ),
      readers: new Set<AbortController>(),
    },
  };
}

export function bindCliBridgeRun(
  prepared: CliBridgeRun,
  runs: Map<string, CliBridgeRun>,
): CliBridgeRun | undefined {
  const previous = runs.get(prepared.id);
  runs.set(prepared.id, prepared);
  return previous;
}

export function restoreCliBridgeRun(
  run: CliBridgeRun,
  previous: CliBridgeRun | undefined,
  runs: Map<string, CliBridgeRun>,
): void {
  if (runs.get(run.id) !== run) return;
  if (previous) runs.set(run.id, previous);
  else runs.delete(run.id);
}

export function bindCliBridgeSession(
  run: CliBridgeRun,
  sessions: Map<string, CliBridgeSessionState>,
): CliBridgeRun | undefined {
  if (!run.sessionId) return undefined;
  const previous = sessions.get(run.sessionId)?.current;
  sessions.set(run.sessionId, { id: run.sessionId, current: run });
  return previous;
}

export function restoreCliBridgeSession(
  run: CliBridgeRun,
  previous: CliBridgeRun | undefined,
  sessions: Map<string, CliBridgeSessionState>,
): void {
  if (!run.sessionId || sessions.get(run.sessionId)?.current !== run) return;
  if (previous) sessions.set(run.sessionId, { id: run.sessionId, current: previous });
  else sessions.delete(run.sessionId);
}
