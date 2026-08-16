import { AgentTurnInputSchema } from "@tangle-network/agent-interface";
import { AgentEnvironmentCapabilitiesSchema } from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentExactRunControlRef,
  AgentRunControlRef,
  InteractionAcknowledgement,
  InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentObservation,
  AgentEnvironmentStatus,
  AgentInteractiveSession,
  AgentInteractiveSessionRef,
  AgentInteractiveSessionStart,
  AgentSession,
  AgentTerminalSession,
  AgentTurnInput,
  ExecRequest,
  ExecResult,
  PlacementInfo,
  ResourceProfile,
  TerminalAttachRequest,
  TerminalAttachResult,
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
import {
  capabilitiesForSandbox,
  frozenCapabilityDocument,
  sandboxCapabilitySupport,
} from "./tangle-capabilities.js";
import { readDeploymentCapabilitySupport } from "./tangle-deployment-capabilities.js";
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
import { tangleInteractionResponder } from "./tangle-interaction-response.js";
import { createExecutionUsageLog } from "./tangle-usage-log.js";
import { observeTangleEnvironment } from "./tangle-observation.js";
import { createTangleTerminalRegistry } from "./tangle-terminal.js";
import { createTangleInteractiveAgentRegistry } from "./tangle-interactive.js";

/**
 * Compose one concrete sandbox into an environment.
 *
 * This is the only stage that can read deployment truth, so it does: one
 * `GET /capabilities` against the sandbox decides retained control, and the
 * environment then exposes exactly the operations both the adapter surface
 * and the deployment back. A deployment that cannot disclose a readable
 * document yields no retained-control surface at all. The environment
 * publishes the resulting document on `capabilities`, so a caller reads the
 * answer for this sandbox rather than the provider's pre-sandbox claim.
 *
 * The document is measured once, here. A sandbox that is not yet running
 * cannot answer, so an environment composed during provisioning claims
 * nothing and keeps claiming nothing: the exposed operations and the document
 * are composed together and a caller may already hold either one. Compose the
 * environment again through `provider.get(id)` once the sandbox is running.
 *
 * @param request What the create call asked for. An environment rebuilt by id
 * carries none of it, so its observation reports the requested compute shape
 * as absent instead of restating a request it never saw.
 */
export async function sandboxInstanceAsEnvironment(
  box: SandboxInstanceLike,
  providerName: string,
  client: SandboxClientLike,
  declaredCapabilities: AgentEnvironmentCapabilities,
  operation?: { signal?: AbortSignal },
  request?: { resources?: ResourceProfile },
): Promise<AgentEnvironment> {
  const environmentId = boundedIdentifier(box.id, "Tangle environment id");
  boundedIdentifier(providerName, "Tangle provider name");
  if (box.metadata !== undefined) {
    if (!box.metadata || typeof box.metadata !== "object" || Array.isArray(box.metadata)) {
      throw new Error("Tangle environment metadata must be a JSON object");
    }
    assertBoundedJson(box.metadata);
  }
  const support = sandboxCapabilitySupport(box, client, request?.resources);
  const deployment = await readDeploymentCapabilitySupport(box, operation);
  const capabilities = frozenCapabilityDocument(
    AgentEnvironmentCapabilitiesSchema.parse(
      capabilitiesForSandbox(declaredCapabilities, support, deployment),
    ),
  );
  // The published document is the single source for what this environment
  // offers, so the session surface reads its grant from there.
  const retainedControl = capabilities.retainedControl !== undefined;
  const interactionResponses = capabilities.interactions !== undefined;
  // Usage is measured per execution, so the log collects what runs through
  // this handle and the observation reports the newest record it holds.
  const usageLog = createExecutionUsageLog();
  const terminals =
    capabilities.interactiveTerminal?.attach === true
      ? createTangleTerminalRegistry(box)
      : undefined;
  const interactiveAgents =
    capabilities.interactiveAgent?.start === true &&
    capabilities.interactiveAgent.control === true
      ? createTangleInteractiveAgentRegistry(box, providerName, environmentId)
      : undefined;
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
    ...(box.metadata ? { metadata: snapshotMetadata(box.metadata) } : {}),
    capabilities,
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
          usageLog.record(expectedExecutionId, converted.usage);
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
              retainedControl,
              interactionResponses,
              usageLog,
            );
            // sessions.continue was granted from the probe session and the
            // deployment document together; this backstop holds every
            // concrete session to that grant, so a client whose sessions
            // diverge from its probe surface fails loud here instead of
            // failing at the first cancellation.
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
    ...(interactionResponses && box.session
      ? {
          respondToInteraction(
            command: InteractionResponseCommand,
            options?: { signal?: AbortSignal },
          ): Promise<InteractionAcknowledgement> {
            assertOptionKeys(options, ["signal"], "Tangle interaction response");
            options?.signal?.throwIfAborted();
            // The command names its own session, so the environment answers an
            // ask on any session of this sandbox without the caller holding a
            // session object. The binding is checked against this handle, so a
            // command for another session is refused rather than delivered.
            const sessionId = boundedIdentifier(
              command?.binding?.sessionId,
              "Tangle interaction session id",
            );
            const session = box.session?.(
              sessionId,
              options?.signal ? { signal: options.signal } : undefined,
            );
            if (!session) throw new Error("sandbox session(id) returned undefined");
            if (session.id !== sessionId) {
              throw new Error("sandbox session(id) returned an unrelated session");
            }
            return tangleInteractionResponder({
              session,
              sessionId,
              provider: providerName,
              environmentId,
            })(command, options);
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
    ...(capabilities.observation
      ? {
          async observe(options?: {
            signal?: AbortSignal;
          }): Promise<AgentEnvironmentObservation> {
            assertOptionKeys(options, ["signal"], "Tangle observe");
            return await observeTangleEnvironment(
              {
                box,
                client,
                provider: providerName,
                environmentId,
                ...(request?.resources === undefined
                  ? {}
                  : { requestedResources: request.resources }),
                usageLog,
              },
              options,
            );
          },
        }
      : {}),
    ...(terminals
      ? {
          async attachTerminal(
            terminalRequest: TerminalAttachRequest,
            options?: { signal?: AbortSignal },
          ): Promise<TerminalAttachResult> {
            return await terminals.attach(terminalRequest, options);
          },
          terminal(
            terminalSessionId: string,
            options?: { signal?: AbortSignal },
          ): AgentTerminalSession {
            boundedIdentifier(terminalSessionId, "Tangle terminal session id");
            assertOptionKeys(options, ["signal"], "Tangle terminal");
            options?.signal?.throwIfAborted();
            return terminals.get(terminalSessionId);
          },
        }
      : {}),
    ...(interactiveAgents
      ? {
          async startInteractive(
            interactiveRequest: AgentInteractiveSessionStart,
            options?: { signal?: AbortSignal },
          ): Promise<AgentInteractiveSessionRef> {
            return await interactiveAgents.start(interactiveRequest, options);
          },
          interactive(
            ref: AgentInteractiveSessionRef,
          ): AgentInteractiveSession {
            return interactiveAgents.get(ref);
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

function snapshotMetadata(
  metadata: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return deepFreeze(structuredClone(metadata));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
