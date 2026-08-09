import { AgentTurnInputSchema } from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentEvent,
  AgentSession,
  AgentSessionStatus,
  AgentTurnInput,
  AgentTurnResult,
} from "@tangle-network/agent-interface/environment-provider";
import type { AgentRunControlRef } from "@tangle-network/agent-interface";
import type { SandboxSessionLike } from "./tangle-types.js";
import { environmentEventFromSandboxEvent } from "./tangle-events.js";
import {
  agentTurnResultFromPromptRecord,
  promptFromTurnInput,
  promptOptionsFromTurnInput,
  validatedSandboxPromptResult,
} from "./tangle-prompt.js";
import {
  retainedSessionControlRef,
  resolveRetainedSessionControlRef,
  sameRunControlRef,
  sessionPromptExecutionId,
} from "./tangle-session-control.js";
import { sessionStatusFromUnknown } from "./tangle-environment-values.js";
import {
  awaitWithSignal,
  boundedIdentifier,
} from "./tangle-contract-safety.js";
import { assertOptionKeys } from "./tangle-environment-validation.js";
import {
  hasReplayPayload,
  interruptExecutionAfterAbort,
  sessionPromptRequestDigest,
} from "./tangle-environment-control.js";

export function sandboxSessionAsAgentSession(
  session: SandboxSessionLike,
  controlRef: AgentRunControlRef | undefined,
  provider: string,
  environmentId: string,
): AgentSession {
  let activeControlRef = controlRef;
  return {
    id: session.id,
    get controlRef(): AgentRunControlRef | undefined {
      return activeControlRef;
    },
    async status(options?: { signal?: AbortSignal }): Promise<AgentSessionStatus | null> {
      assertOptionKeys(options, ["signal"], "Tangle session status");
      const status = await awaitWithSignal(session.status(options), options?.signal);
      options?.signal?.throwIfAborted();
      if (!status) return null;
      return sessionStatusFromUnknown((status as { status?: unknown }).status);
    },
    async *events(options?: { since?: string; executionId?: string; signal?: AbortSignal }): AsyncIterable<AgentEnvironmentEvent> {
      assertOptionKeys(options, ["since", "executionId", "signal"], "Tangle session events");
      if (options?.since !== undefined) boundedIdentifier(options.since, "Tangle event cursor");
      if (options?.executionId !== undefined) boundedIdentifier(options.executionId, "Tangle execution id");
      if (options?.executionId !== undefined && activeControlRef?.executionId !== options.executionId) {
        throw new Error("Tangle replay executionId conflicts with the control reference");
      }
      const executionId = activeControlRef?.executionId ?? options?.executionId;
      if (options?.since !== undefined && executionId === undefined) {
        throw new Error("Tangle cursor replay requires an exact executionId from its control reference");
      }
      options?.signal?.throwIfAborted();
      const seenEventIds = new Set<string>();
      const iterator = session.events({
        ...(options?.since !== undefined ? { since: options.since } : {}),
        ...(executionId !== undefined ? { executionId } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      })[Symbol.asyncIterator]();
      let completed = false;
      try {
        while (true) {
          const next = await awaitWithSignal(iterator.next(), options?.signal);
          if (next.done) {
            completed = true;
            break;
          }
          options?.signal?.throwIfAborted();
          if (options?.since !== undefined && next.value.id === options.since) continue;
          const converted = environmentEventFromSandboxEvent(next.value, {
            executionId,
            sessionId: session.id,
          });
          if (converted.id === undefined) throw new Error("Tangle session event arrived without a stable id");
          if (seenEventIds.has(converted.id)) throw new Error(`Tangle session replay repeated event id ${converted.id}`);
          seenEventIds.add(converted.id);
          options?.signal?.throwIfAborted();
          yield converted;
        }
      } finally {
        if (!completed) {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        }
      }
      options?.signal?.throwIfAborted();
    },
    async result(options?: { signal?: AbortSignal }): Promise<AgentTurnResult> {
      assertOptionKeys(options, ["signal"], "Tangle session result");
      const expectedExecutionId = activeControlRef?.executionId;
      if (expectedExecutionId === undefined) throw new Error("Tangle session result requires an exact executionId from its control reference");
      const result = await awaitWithSignal(session.result({ executionId: expectedExecutionId, signal: options?.signal }), options?.signal);
      options?.signal?.throwIfAborted();
      const resultRecord = validatedSandboxPromptResult(result);
      if (resultRecord.executionId !== expectedExecutionId) throw new Error("Tangle session result did not confirm its exact executionId");
      return agentTurnResultFromPromptRecord(resultRecord, { sessionId: session.id });
    },
    async prompt(input: AgentTurnInput): Promise<AgentTurnResult> {
      AgentTurnInputSchema.parse(input);
      input.signal?.throwIfAborted();
      if (input.sessionId !== undefined && input.sessionId !== session.id) throw new Error("Tangle sessionId conflicts with this session");
      const requestedControlRef = resolveRetainedSessionControlRef(input.controlRef, session.id, provider, environmentId);
      if (activeControlRef && requestedControlRef && !sameRunControlRef(activeControlRef, requestedControlRef)) throw new Error("Tangle prompt control reference conflicts with this session");
      const sourceControlRef = requestedControlRef ?? activeControlRef;
      const replay = input.lastEventId !== undefined;
      if (replay && sourceControlRef?.executionId !== undefined && input.executionId !== undefined && input.executionId !== sourceControlRef.executionId) throw new Error("Tangle replay executionId conflicts with the control reference");
      if (replay && sourceControlRef?.requestDigest === undefined) {
        throw new Error("Tangle replay requires an exact request digest from its control reference");
      }
      const executionId = replay ? input.executionId ?? sourceControlRef?.executionId : input.executionId ?? sessionPromptExecutionId(provider, environmentId, session.id, input.turnId);
      if (executionId === undefined) throw new Error("Tangle session replay requires the exact executionId from its control reference");
      const computedRequestDigest = sessionPromptRequestDigest(
        input,
        provider,
        environmentId,
        session.id,
        executionId,
      );
      const sameExecution = sourceControlRef?.executionId === executionId;
      if (
        sourceControlRef?.requestDigest !== undefined &&
        sameExecution &&
        (!replay || hasReplayPayload(input)) &&
        sourceControlRef.requestDigest !== computedRequestDigest
      ) {
        throw new Error("Tangle prompt request digest conflicts with the control reference");
      }
      const requestDigest =
        replay || sameExecution
          ? sourceControlRef?.requestDigest
          : computedRequestDigest;
      if (requestDigest === undefined) {
        throw new Error("Tangle prompt could not establish an exact request digest");
      }
      const promptInput = replay
        ? { ...input, sessionId: session.id, executionId, controlRef: sourceControlRef }
        : { ...input, sessionId: session.id, executionId, controlRef: undefined };
      try {
        const result = await awaitWithSignal(
          session.prompt(
            promptFromTurnInput(input),
            promptOptionsFromTurnInput(promptInput, { provider, environmentId, sessionId: session.id }),
          ),
          input.signal,
        );
        input.signal?.throwIfAborted();
        const resultRecord = validatedSandboxPromptResult(result);
        if (resultRecord.executionId !== executionId) {
          void interruptExecutionAfterAbort(session, session.id, executionId);
          throw new Error("Tangle session prompt did not confirm its exact executionId");
        }
        activeControlRef = retainedSessionControlRef(session.id, executionId, provider, environmentId, requestDigest);
        return agentTurnResultFromPromptRecord(resultRecord, {
          sessionId: session.id,
          ...(input.contextTransfer ? { contextTransferRequest: input.contextTransfer } : {}),
          ...(input.contextTransfer ? { contextTransferRequested: true } : {}),
        });
      } catch (error) {
        if (input.signal?.aborted) {
          void interruptExecutionAfterAbort(session, session.id, executionId);
        }
        throw error;
      }
    },
    async cancel(options?: { signal?: AbortSignal }): Promise<void> {
      assertOptionKeys(options, ["signal"], "Tangle session cancel");
      const executionId = activeControlRef?.executionId;
      if (executionId === undefined) throw new Error("Tangle session cancellation requires an exact executionId from its control reference");
      options?.signal?.throwIfAborted();
      const result = await awaitWithSignal(session.interrupt({ executionId, signal: options?.signal }), options?.signal);
      options?.signal?.throwIfAborted();
      if (result.cancelled !== true) throw new Error("Tangle sandbox did not confirm cancellation");
    },
  };
}
