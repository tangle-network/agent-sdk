import { randomUUID } from "node:crypto";
import { AgentTurnInputSchema } from "@tangle-network/agent-interface";
import {
  AgentRunCancellationAcknowledgementSchema,
  AgentRunCancellationRequestSchema,
  agentRunCancellationAcknowledgementMatchesRequest,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentEvent,
  AgentSession,
  AgentSessionRef,
  AgentSessionStatus,
  AgentTurnInput,
  AgentTurnResult,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentExactRunControlRef,
  AgentRunCancellationAcknowledgement,
  AgentRunCancellationRequest,
  AgentRunControlRef,
} from "@tangle-network/agent-interface";
import type { SandboxEvent } from "@tangle-network/sandbox";
import type { SandboxSessionLike } from "./tangle-types.js";
import {
  carriedSessionIds,
  environmentEventFromSandboxEvent,
  isSandboxConnectionMarker,
  sandboxEventIdentity,
} from "./tangle-events.js";
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
import {
  executionBoundSessionStatus,
  sessionStatusFromUnknown,
} from "./tangle-environment-values.js";
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

type ExactExecutionEventStream = (options: {
  sessionId: string;
  executionId: string;
  since?: string;
  signal?: AbortSignal;
  controlRef?: AgentExactRunControlRef;
}) => AsyncIterable<SandboxEvent>;

/**
 * @param retainedControl Whether the environment's narrowed capability
 * document grants retained control. Canonical cancellation is offered only
 * under that grant: a `cancelRun` method the deployment does not honor is an
 * action the caller selects and finds rejected on the wire.
 */
export function sandboxSessionAsAgentSession(
  session: SandboxSessionLike,
  controlRef: AgentRunControlRef | undefined,
  provider: string,
  environmentId: string,
  dispatch: ((input: AgentTurnInput) => Promise<AgentSessionRef>) | undefined,
  exactExecutionEvents: ExactExecutionEventStream | undefined,
  retainedControl: boolean,
): AgentSession {
  let activeControlRef: AgentExactRunControlRef | undefined = controlRef
    ? resolveRetainedSessionControlRef(controlRef, session.id, provider, environmentId)
    : undefined;
  let promptInFlight = false;
  const cancelRunMethod = retainedControl ? session.cancelRun : undefined;
  const cancelRun = typeof cancelRunMethod === "function"
    ? async (
        request: AgentRunCancellationRequest,
        options?: { signal?: AbortSignal },
      ): Promise<AgentRunCancellationAcknowledgement> => {
        assertOptionKeys(options, ["signal"], "Tangle exact session cancellation");
        const exactRequest = AgentRunCancellationRequestSchema.parse(request);
        const expectedRun = activeControlRef;
        if (expectedRun === undefined) {
          throw new Error(
            "Tangle exact session cancellation requires an exact run control reference",
          );
        }
        if (!sameRunControlRef(exactRequest.run, expectedRun)) {
          throw new Error(
            "Tangle exact session cancellation targets another run, session, execution, or request",
          );
        }
        options?.signal?.throwIfAborted();
        const acknowledgement = await awaitWithSignal(
          cancelRunMethod.call(
            session,
            exactRequest,
            options?.signal ? { signal: options.signal } : undefined,
          ),
          options?.signal,
        );
        options?.signal?.throwIfAborted();
        const exactAcknowledgement =
          AgentRunCancellationAcknowledgementSchema.parse(acknowledgement);
        if (
          !agentRunCancellationAcknowledgementMatchesRequest(
            exactRequest,
            exactAcknowledgement,
          ) ||
          !sameRunControlRef(exactAcknowledgement.run, expectedRun)
        ) {
          throw new Error(
            "Tangle exact session cancellation returned an acknowledgement for another run, session, execution, or request",
          );
        }
        return exactAcknowledgement;
      }
    : undefined;
  return {
    id: session.id,
    get controlRef(): AgentRunControlRef | undefined {
      return activeControlRef === undefined ? undefined : { ...activeControlRef };
    },
    async status(options?: { signal?: AbortSignal }): Promise<AgentSessionStatus | null> {
      assertOptionKeys(options, ["signal"], "Tangle session status");
      const status = await awaitWithSignal(session.status(options), options?.signal);
      options?.signal?.throwIfAborted();
      if (!status) return null;
      const expectedExecutionId = activeControlRef?.executionId;
      // Sandbox reports session-wide status. With an exact control reference,
      // the answer is only valid when the payload binds to that execution.
      if (expectedExecutionId !== undefined) {
        return executionBoundSessionStatus(status, expectedExecutionId);
      }
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
      const useExactExecutionStream =
        exactExecutionEvents !== undefined && executionId !== undefined;
      const iterator = (useExactExecutionStream
        ? exactExecutionEvents({
            sessionId: session.id,
            executionId,
            ...(options?.since !== undefined ? { since: options.since } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(activeControlRef ? { controlRef: activeControlRef } : {}),
          })
        : session.events({
            ...(options?.since !== undefined ? { since: options.since } : {}),
            ...(executionId !== undefined ? { executionId } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
          }))[Symbol.asyncIterator]();
      let completed = false;
      try {
        while (true) {
          const next = await awaitWithSignal(iterator.next(), options?.signal);
          if (next.done) {
            completed = true;
            break;
          }
          options?.signal?.throwIfAborted();
          if (isSandboxConnectionMarker(next.value)) {
            const markerIdentity = sandboxEventIdentity(next.value);
            if (
              executionId !== undefined &&
              markerIdentity.executionId !== undefined &&
              markerIdentity.executionId !== executionId
            ) {
              throw new Error(
                "Tangle exact session connection identified a different executionId",
              );
            }
            // Every position that names a session on the marker names the
            // session the stream was opened for. The marker carries no native
            // id, so no position is exempt.
            for (const carried of carriedSessionIds(markerIdentity)) {
              if (carried !== session.id) {
                throw new Error(
                  "Tangle exact session connection identified a different sessionId",
                );
              }
            }
            continue;
          }
          const converted = environmentEventFromSandboxEvent(next.value, {
            executionId,
            sessionId: session.id,
            ...(useExactExecutionStream ? { streamBound: true } : {}),
          });
          if (converted.id === undefined) throw new Error("Tangle session event arrived without a stable id");
          if (seenEventIds.has(converted.id)) continue;
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
      return agentTurnResultFromPromptRecord(resultRecord, {
        sessionId: session.id,
        controlRef: activeControlRef,
      });
    },
    async prompt(input: AgentTurnInput): Promise<AgentTurnResult> {
      AgentTurnInputSchema.parse(input);
      input.signal?.throwIfAborted();
      if (promptInFlight) {
        throw new Error("Tangle session already has a prompt in flight");
      }
      promptInFlight = true;
      try {
        if (input.sessionId !== undefined && input.sessionId !== session.id) {
          throw new Error("Tangle sessionId conflicts with this session");
        }
        const requestedControlRef = resolveRetainedSessionControlRef(
          input.controlRef,
          session.id,
          provider,
          environmentId,
        );
        if (
          activeControlRef &&
          requestedControlRef &&
          !sameRunControlRef(activeControlRef, requestedControlRef)
        ) {
          throw new Error("Tangle prompt control reference conflicts with this session");
        }
        if (
          requestedControlRef?.executionId !== undefined &&
          input.executionId !== undefined &&
          requestedControlRef.executionId !== input.executionId
        ) {
          throw new Error("Tangle executionId conflicts with the control reference");
        }
        if (input.detach === true && input.lastEventId === undefined) {
          if (dispatch === undefined) {
            throw new Error(
              "Tangle detached session prompt requires the sandbox dispatch primitive",
            );
          }
          const detachedInput: AgentTurnInput = {
            ...input,
            signal: undefined,
            controlRef: undefined,
            sessionId: session.id,
            detach: true,
            ...(input.turnId === undefined ? { turnId: randomUUID() } : {}),
          };
          const reference = await dispatch(detachedInput);
          const nextControlRef = resolveRetainedSessionControlRef(
            reference.controlRef,
            session.id,
            provider,
            environmentId,
          );
          if (nextControlRef === undefined) {
            throw new Error(
              "Tangle detached session dispatch returned no exact control reference",
            );
          }
          // The admission receipt is the durability boundary. Store it before
          // waiting for the result so an aborted caller can reconnect later.
          activeControlRef = nextControlRef;
          const result = await awaitWithSignal(
            session.result({
              executionId: nextControlRef.executionId,
              ...(input.signal ? { signal: input.signal } : {}),
            }),
            input.signal,
          );
          input.signal?.throwIfAborted();
          const resultRecord = validatedSandboxPromptResult(result);
          if (resultRecord.executionId !== nextControlRef.executionId) {
            throw new Error(
              "Tangle detached session prompt did not confirm its exact executionId",
            );
          }
          return agentTurnResultFromPromptRecord(resultRecord, {
            sessionId: session.id,
            controlRef: nextControlRef,
          });
        }
        const sourceControlRef = requestedControlRef ?? activeControlRef;
        const replay = input.lastEventId !== undefined;
        if (
          replay &&
          sourceControlRef?.executionId !== undefined &&
          input.executionId !== undefined &&
          input.executionId !== sourceControlRef.executionId
        ) {
          throw new Error("Tangle replay executionId conflicts with the control reference");
        }
        if (replay && sourceControlRef?.requestDigest === undefined) {
          throw new Error(
            "Tangle replay requires an exact request digest from its control reference",
          );
        }
        const requestedExecutionId =
          input.executionId ?? requestedControlRef?.executionId;
        const nonce =
          !replay &&
          input.turnId === undefined &&
          requestedExecutionId === undefined &&
          requestedControlRef === undefined
            ? randomUUID()
            : undefined;
        const baseRequestDigest = sessionPromptRequestDigest(
          input,
          provider,
          environmentId,
          session.id,
          nonce === undefined ? {} : { nonce },
        );
        const executionId = replay
          ? input.executionId ?? sourceControlRef?.executionId
          : requestedExecutionId ?? sessionPromptExecutionId(baseRequestDigest);
        if (executionId === undefined) {
          throw new Error(
            "Tangle session replay requires the exact executionId from its control reference",
          );
        }
        const explicitRequestDigest = sessionPromptRequestDigest(
          input,
          provider,
          environmentId,
          session.id,
          {
            executionId,
            ...(nonce === undefined ? {} : { nonce }),
          },
        );
        if (
          !replay &&
          requestedControlRef?.requestDigest !== undefined &&
          requestedControlRef.requestDigest !== explicitRequestDigest
        ) {
          throw new Error(
            "Tangle prompt request digest conflicts with the control reference",
          );
        }
        if (
          replay &&
          hasReplayPayload(input) &&
          sourceControlRef?.requestDigest !== explicitRequestDigest
        ) {
          throw new Error(
            "Tangle prompt request digest conflicts with the control reference",
          );
        }
        const requestDigest = replay
          ? sourceControlRef?.requestDigest
          : requestedControlRef?.requestDigest ?? explicitRequestDigest;
        if (requestDigest === undefined) {
          throw new Error("Tangle prompt could not establish an exact request digest");
        }
        const targetControlRef = retainedSessionControlRef(
          session.id,
          executionId,
          provider,
          environmentId,
          requestDigest,
          requestedControlRef?.runId,
        );
        const promptInput = replay
          ? {
              ...input,
              sessionId: session.id,
              executionId,
              controlRef: sourceControlRef,
            }
          : {
              ...input,
              sessionId: session.id,
              executionId,
              controlRef: targetControlRef,
            };
        try {
          const result = await awaitWithSignal(
            session.prompt(
              promptFromTurnInput(input),
              promptOptionsFromTurnInput(promptInput, {
                provider,
                environmentId,
                sessionId: session.id,
              }),
            ),
            input.signal,
          );
          input.signal?.throwIfAborted();
          const resultRecord = validatedSandboxPromptResult(result);
          if (resultRecord.executionId !== executionId) {
            void interruptExecutionAfterAbort(session, session.id, executionId);
            throw new Error(
              "Tangle session prompt did not confirm its exact executionId",
            );
          }
          const nextControlRef = targetControlRef;
          activeControlRef = nextControlRef;
          return agentTurnResultFromPromptRecord(resultRecord, {
            sessionId: session.id,
            controlRef: nextControlRef,
            ...(input.contextTransfer
              ? { contextTransferRequest: input.contextTransfer }
              : {}),
            ...(input.contextTransfer
              ? { contextTransferRequested: true }
              : {}),
          });
        } catch (error) {
          if (input.signal?.aborted && input.detach !== true) {
            void interruptExecutionAfterAbort(session, session.id, executionId);
          }
          throw error;
        }
      } finally {
        promptInFlight = false;
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
    ...(cancelRun ? { cancelRun } : {}),
  };
}
