import { AgentTurnInputSchema } from "@tangle-network/agent-interface";
import type {
  AgentExactRunControlRef,
  AgentRunControlRef,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentStatus,
  AgentSession,
  AgentTurnInput,
  ExecRequest,
  ExecResult,
  PlacementInfo,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
} from "./tangle-types.js";
import { environmentEventFromSandboxEvent } from "./tangle-events.js";
import {
  executionIdFromTurnInput,
  promptFromTurnInput,
  promptOptionsFromTurnInput,
} from "./tangle-prompt.js";
import { resolveRetainedSessionControlRef } from "./tangle-session-control.js";
import {
  placementInfoFromLoopPlacement,
  statusFromUnknown,
} from "./tangle-environment-values.js";
import { execResultFromSandboxExecResult } from "./tangle-result-values.js";
import { capabilitiesForSandbox, sandboxCapabilitySupport } from "./tangle-capabilities.js";
import {
  awaitWithSignal,
  assertBoundedJson,
  boundedIdentifier,
  boundedString,
} from "./tangle-contract-safety.js";
import {
  assertExecOptions,
  assertOptionKeys,
} from "./tangle-environment-validation.js";
import {
  interruptExecutionAfterAbort,
} from "./tangle-environment-control.js";
import { dispatchEnvironmentRun } from "./tangle-environment-dispatch.js";
import { sandboxSessionAsAgentSession } from "./tangle-environment-session.js";

export function sandboxInstanceAsEnvironment(
  box: SandboxInstanceLike,
  providerName: string,
  client: SandboxClientLike,
  declaredCapabilities: AgentEnvironmentCapabilities,
): AgentEnvironment {
  const environmentId = boundedIdentifier(box.id, "Tangle environment id");
  boundedIdentifier(providerName, "Tangle provider name");
  if (box.metadata !== undefined) {
    if (!box.metadata || typeof box.metadata !== "object" || Array.isArray(box.metadata)) {
      throw new Error("Tangle environment metadata must be a JSON object");
    }
    assertBoundedJson(box.metadata);
  }
  const support = sandboxCapabilitySupport(box, client);
  const capabilities = capabilitiesForSandbox(declaredCapabilities, support);
  const dispatch =
    capabilities.streaming.detach && box.dispatchPrompt
      ? dispatchEnvironmentRun(box, providerName, environmentId)
      : undefined;
  const exactExecutionEvents = (options: {
    sessionId: string;
    executionId: string;
    since?: string;
    signal?: AbortSignal;
    controlRef?: AgentExactRunControlRef;
  }) =>
    box.streamPrompt("", {
      sessionId: options.sessionId,
      executionId: options.executionId,
      // The execution replay endpoint owns stable event IDs. A missing cursor
      // starts at the beginning so the caller can journal a complete run.
      lastEventId: options.since ?? "0",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.controlRef ? { runControlRef: options.controlRef } : {}),
    });
  return {
    id: environmentId,
    provider: providerName,
    ...(box.name ? { name: boundedString(box.name, "Tangle environment name") } : {}),
    async status(options?: { signal?: AbortSignal }): Promise<AgentEnvironmentStatus> {
      assertOptionKeys(options, ["signal"], "Tangle environment status");
      await awaitWithSignal(box.refresh?.(options), options?.signal);
      return statusFromUnknown(box.status);
    },
    async *stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent> {
      AgentTurnInputSchema.parse(input);
      input.signal?.throwIfAborted();
      const expectedExecutionId = executionIdFromTurnInput(input);
      const expectedSessionId = input.sessionId ?? input.controlRef?.sessionId;
      const iterator = box.streamPrompt(
        promptFromTurnInput(input),
        promptOptionsFromTurnInput(input, {
          provider: providerName,
          environmentId,
        }),
      )[Symbol.asyncIterator]();
      let completed = false;
      try {
        while (true) {
          const next = await awaitWithSignal(iterator.next(), input.signal);
          if (next.done) {
            completed = true;
            break;
          }
          input.signal?.throwIfAborted();
          const converted = environmentEventFromSandboxEvent(next.value, {
            executionId: expectedExecutionId,
            sessionId: expectedSessionId,
            ...(expectedExecutionId !== undefined || expectedSessionId !== undefined
              ? { streamBound: true }
              : {}),
          });
          input.signal?.throwIfAborted();
          yield converted;
        }
      } catch (error) {
        if (
          input.signal?.aborted &&
          input.detach !== true &&
          expectedSessionId !== undefined &&
          expectedExecutionId !== undefined
        ) {
          void interruptExecutionAfterAbort(
            box,
            expectedSessionId,
            expectedExecutionId,
          );
        }
        throw error;
      } finally {
        if (!completed) {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        }
      }
      input.signal?.throwIfAborted();
    },
    ...(dispatch ? { dispatch } : {}),
    ...((capabilities.sessions.continue || capabilities.streaming.replay || capabilities.streaming.detach) &&
    box.session
      ? {
          session(id: string, options?: { controlRef?: AgentRunControlRef; signal?: AbortSignal }): AgentSession {
            boundedIdentifier(id, "Tangle session id");
            assertOptionKeys(options, ["controlRef", "signal"], "Tangle session");
            options?.signal?.throwIfAborted();
            const session = box.session?.(
              id,
              options?.signal ? { signal: options.signal } : undefined,
            );
            if (!session) throw new Error("sandbox session(id) returned undefined");
            options?.signal?.throwIfAborted();
            boundedIdentifier(session.id, "Tangle session id");
            if (session.id !== id) {
              throw new Error("sandbox session(id) returned an unrelated session");
            }
            const agentSession = sandboxSessionAsAgentSession(
              session,
              resolveRetainedSessionControlRef(options?.controlRef, id, providerName, environmentId),
              providerName,
              environmentId,
              dispatch,
              exactExecutionEvents,
            );
            // sessions.continue was granted from a probe-session fact; this
            // backstop holds every concrete session to that fact, so a client
            // whose sessions diverge from its probe surface fails loud here
            // instead of failing at the first cancellation.
            if (
              capabilities.sessions.continue &&
              typeof agentSession.cancelRun !== "function"
            ) {
              throw new Error(
                "Tangle retained session support requires SandboxSession.cancelRun",
              );
            }
            return agentSession;
          },
        }
      : {}),
    ...(capabilities.workspace.read && box.read
      ? {
          async read(path: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<string> {
            boundedString(path, "Tangle path");
            assertOptionKeys(options, ["sessionId", "signal"], "Tangle read");
            if (options?.sessionId !== undefined) boundedIdentifier(options.sessionId, "Tangle read session id");
            options?.signal?.throwIfAborted();
            const content = await awaitWithSignal(box.read?.(path, options), options?.signal);
            options?.signal?.throwIfAborted();
            return boundedString(content, "Tangle file content");
          },
        }
      : {}),
    ...(capabilities.workspace.write && box.write
      ? {
          async write(path: string, content: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<void> {
            boundedString(path, "Tangle path");
            boundedString(content, "Tangle file content");
            assertOptionKeys(options, ["sessionId", "signal"], "Tangle write");
            if (options?.sessionId !== undefined) boundedIdentifier(options.sessionId, "Tangle write session id");
            options?.signal?.throwIfAborted();
            await awaitWithSignal(box.write?.(path, content, options), options?.signal);
            options?.signal?.throwIfAborted();
          },
        }
      : {}),
    ...(capabilities.workspace.exec && box.exec
      ? {
          async exec(command: string, options?: ExecRequest): Promise<ExecResult> {
            boundedString(command, "Tangle command");
            assertExecOptions(options);
            options?.signal?.throwIfAborted();
            const result = await awaitWithSignal(box.exec?.(command, options as never), options?.signal);
            options?.signal?.throwIfAborted();
            return execResultFromSandboxExecResult(result);
          },
        }
      : {}),
    ...(capabilities.placement
      ? {
          async placement(options?: { signal?: AbortSignal }): Promise<PlacementInfo> {
            assertOptionKeys(options, ["signal"], "Tangle placement");
            options?.signal?.throwIfAborted();
            const placement = await awaitWithSignal(
              Promise.resolve(client.describePlacement?.(box)),
              options?.signal,
            );
            options?.signal?.throwIfAborted();
            return placementInfoFromLoopPlacement(placement, box);
          },
        }
      : {}),
    async refresh(options?: { signal?: AbortSignal }): Promise<void> {
      assertOptionKeys(options, ["signal"], "Tangle refresh");
      options?.signal?.throwIfAborted();
      await awaitWithSignal(box.refresh?.(options), options?.signal);
      options?.signal?.throwIfAborted();
    },
    ...(support.destroy
      ? {
          async destroy(options?: { signal?: AbortSignal }): Promise<void> {
            if (!box.delete) throw new Error("Tangle sandbox client cannot delete this environment");
            assertOptionKeys(options, ["signal"], "Tangle destroy");
            options?.signal?.throwIfAborted();
            await awaitWithSignal(box.delete(options), options?.signal);
            options?.signal?.throwIfAborted();
          },
        }
      : {}),
  };
}
