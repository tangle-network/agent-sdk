import {
  AgentInteractiveSessionAttachSchema,
  AgentInteractiveSessionControlClaimAcknowledgementSchema,
  AgentInteractiveSessionControlClaimRequestSchema,
  AgentInteractiveSessionPromptAcknowledgementSchema,
  AgentInteractiveSessionPromptCommandSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStatusSchema,
  AgentInteractiveSessionStopAcknowledgementSchema,
  AgentInteractiveSessionStopCommandSchema,
  agentInteractiveSessionControlClaimAcknowledgementMatchesRequest,
  agentInteractiveSessionControlClaimMatchesRef,
  agentInteractiveSessionPromptAcknowledgementMatchesCommand,
  agentInteractiveSessionRefMatchesStart,
  agentInteractiveSessionStopAcknowledgementMatchesCommand,
  canonicalCandidateDigest,
  exactAgentInteractiveSessionStart,
} from "@tangle-network/agent-interface";
import type {
  AgentInteractiveSession,
  AgentInteractiveSessionControlClaim,
  AgentInteractiveSessionPromptAcknowledgement,
  AgentInteractiveSessionPromptCommand,
  AgentInteractiveSessionRef,
  AgentInteractiveSessionStart,
  AgentInteractiveSessionStatus,
  AgentInteractiveSessionStopAcknowledgement,
  AgentInteractiveSessionStopCommand,
  AgentInteractiveTerminalSession,
} from "@tangle-network/agent-interface";
import { parseBackendType } from "@tangle-network/sandbox";
import { assertOptionKeys } from "./tangle-environment-validation.js";
import { transportFailureReason } from "./tangle-failure-reason.js";
import {
  bindTangleInteractiveControl,
  closeTangleStreamQuietly,
  createTangleTerminalStreamCapture,
  prepareTangleTerminalAttachment,
} from "./tangle-terminal.js";
import type {
  SandboxInstanceLike,
  SandboxInteractiveSessionLike,
  SandboxInteractiveSessionStatusLike,
  SandboxTerminalStreamLike,
} from "./tangle-types.js";

/** Exact coding-agent TUI operations for one sandbox environment. */
export interface TangleInteractiveAgentRegistry {
  start(
    request: AgentInteractiveSessionStart,
    options?: { signal?: AbortSignal },
  ): Promise<AgentInteractiveSessionRef>;
  get(ref: AgentInteractiveSessionRef): AgentInteractiveSession;
}

/**
 * Test the linked SDK surface without accepting any older interactive shape.
 *
 * The current public Sandbox release fails this test. That is intentional:
 * it has no receipt, control claim, or mutation acknowledgement protocol.
 */
export function sandboxBacksInteractiveAgent(box: SandboxInstanceLike): boolean {
  if (typeof box.session !== "function") return false;
  try {
    const candidate = box.session("__tangle-interactive-probe__").interactive?.();
    return (
      isSandboxInteractiveSession(candidate) &&
      typeof box.terminals?.get === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Adapt the canonical Sandbox exact interactive API.
 *
 * The Sandbox owns process identity, admission receipts, operation replay,
 * and control generations. This adapter validates each returned value and
 * never creates a second record for any of those facts.
 */
export function createTangleInteractiveAgentRegistry(
  box: SandboxInstanceLike,
  providerName: string,
  environmentId: string,
): TangleInteractiveAgentRegistry {
  const exactHandle = (sessionId: string): SandboxInteractiveSessionLike => {
    const session = box.session?.(sessionId);
    const candidate = session?.interactive?.();
    if (!isSandboxInteractiveSession(candidate)) {
      throw new Error(
        "the linked Sandbox SDK does not expose the exact interactive control API",
      );
    }
    return candidate;
  };

  const exactRef = (value: AgentInteractiveSessionRef): AgentInteractiveSessionRef => {
    const ref = AgentInteractiveSessionRefSchema.parse(value);
    if (
      ref.run.provider !== providerName ||
      ref.run.environmentId !== environmentId
    ) {
      throw new Error(
        "the interactive agent reference belongs to a different environment",
      );
    }
    return ref;
  };

  const assertRef = (
    expected: AgentInteractiveSessionRef,
    candidate: AgentInteractiveSessionRef,
  ): void => {
    if (!sameExactSessionRef(expected, candidate)) {
      throw new Error("the Sandbox returned a different interactive session ref");
    }
  };

  const assertControl = (
    ref: AgentInteractiveSessionRef,
    control: AgentInteractiveSessionControlClaim,
  ): void => {
    if (!agentInteractiveSessionControlClaimMatchesRef(ref, control)) {
      throw new Error("the interactive control claim belongs to another process");
    }
    if (Date.parse(control.expiresAt) <= Date.now()) {
      throw new Error("the interactive control claim has expired");
    }
  };

  return {
    async start(request, options): Promise<AgentInteractiveSessionRef> {
      assertOptionKeys(options, ["signal"], "Tangle interactive agent start");
      const exactRequest = exactAgentInteractiveSessionStart(request);
      const requestedHarness = exactRequest.profile.harness;
      if (requestedHarness === undefined) {
        throw new Error("interactive agent sessions require AgentProfile.harness");
      }
      let harness: ReturnType<typeof parseBackendType>;
      try {
        harness = parseBackendType(requestedHarness);
      } catch {
        throw new Error(
          "the requested AgentProfile harness has no Tangle Sandbox runner",
        );
      }
      options?.signal?.throwIfAborted();
      const handle = exactHandle(exactRequest.run.sessionId);
      let observed;
      try {
        observed = await handle.start({
          harness,
          ...(exactRequest.profile.model?.default === undefined
            ? {}
            : { model: exactRequest.profile.model.default }),
          ...(exactRequest.cwd === undefined ? {} : { cwd: exactRequest.cwd }),
          ...(exactRequest.cols === undefined ? {} : { cols: exactRequest.cols }),
          ...(exactRequest.rows === undefined ? {} : { rows: exactRequest.rows }),
          profile: exactRequest.profile,
          ...(exactRequest.initialPrompt === undefined
            ? {}
            : { initialPrompt: exactRequest.initialPrompt }),
          idempotencyKey: exactRequest.run.runId,
          requestDigest: exactRequest.run.requestDigest,
        });
      } catch (error) {
        options?.signal?.throwIfAborted();
        throw new Error(transportFailureReason("interactive start", error));
      }
      options?.signal?.throwIfAborted();
      const ref = refFromStart(exactRequest, observed);
      if (!agentInteractiveSessionRefMatchesStart(exactRequest, ref)) {
        throw new Error(
          "the Sandbox returned an interactive session with a different admission receipt",
        );
      }
      return ref;
    },

    get(value): AgentInteractiveSession {
      const ref = exactRef(value);
      const handle = exactHandle(ref.run.sessionId);
      const readStatus = async (
        options?: { signal?: AbortSignal },
      ): Promise<AgentInteractiveSessionStatus> => {
        assertOptionKeys(options, ["signal"], "Tangle interactive agent status");
        options?.signal?.throwIfAborted();
        let observed: SandboxInteractiveSessionStatusLike | null;
        try {
          observed = await handle.status();
        } catch (error) {
          options?.signal?.throwIfAborted();
          throw new Error(transportFailureReason("interactive status", error));
        }
        options?.signal?.throwIfAborted();
        return statusFromSandbox(ref, observed);
      };

      const validateControl = async (
        control: AgentInteractiveSessionControlClaim,
        options?: { signal?: AbortSignal },
      ): Promise<void> => {
        assertControl(ref, control);
        options?.signal?.throwIfAborted();
        try {
          await handle.validateControl(control);
        } catch (error) {
          options?.signal?.throwIfAborted();
          throw new Error(transportFailureReason("interactive control", error));
        }
        options?.signal?.throwIfAborted();
      };

      return {
        ref,
        async claimControl(request, options) {
          assertOptionKeys(options, ["signal"], "Tangle interactive control claim");
          const exactRequest = AgentInteractiveSessionControlClaimRequestSchema.parse(
            request,
          );
          assertRef(ref, exactRequest.ref);
          options?.signal?.throwIfAborted();
          let raw;
          try {
            raw = await handle.claimControl(exactRequest);
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(transportFailureReason("interactive control claim", error));
          }
          options?.signal?.throwIfAborted();
          const acknowledgement =
            AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(raw);
          if (
            !agentInteractiveSessionControlClaimAcknowledgementMatchesRequest(
              exactRequest,
              acknowledgement,
            )
          ) {
            throw new Error(
              "the Sandbox returned a control claim acknowledgement for another request",
            );
          }
          return acknowledgement;
        },
        status: readStatus,
        async attach(request, options): Promise<AgentInteractiveTerminalSession> {
          assertOptionKeys(options, ["signal"], "Tangle interactive agent attach");
          const exactRequest = AgentInteractiveSessionAttachSchema.parse(
            request ?? {},
          );
          await validateControl(exactRequest.control, options);
          const before = await readStatus(options);
          if (before.state !== "running") {
            throw new Error("the exact interactive agent session is not running");
          }
          const terminals = box.terminals;
          if (terminals === undefined || typeof terminals.get !== "function") {
            throw new Error(
              "the Sandbox client cannot read exact interactive terminal metadata",
            );
          }
          const capture = createTangleTerminalStreamCapture(exactRequest);
          let stream: SandboxTerminalStreamLike;
          try {
            stream = await handle.attach({
              control: exactRequest.control,
              ...(exactRequest.cols === undefined ? {} : { cols: exactRequest.cols }),
              ...(exactRequest.rows === undefined ? {} : { rows: exactRequest.rows }),
              handlers: capture.handlers,
            });
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(transportFailureReason("interactive attach", error));
          }
          if (options?.signal?.aborted) {
            await closeTangleStreamQuietly(stream);
            options.signal.throwIfAborted();
          }
          const prepared = await prepareTangleTerminalAttachment({
            stream,
            capture,
            terminals,
            parentExecutionId: ref.run.executionId,
            expectedSessionId: ref.run.sessionId,
            signal: options?.signal,
            beforeMutation: (operation) => {
              if (operation === "detach") return Promise.resolve();
              return validateControl(exactRequest.control, options);
            },
          });
          if (prepared.status === "unknown") {
            throw new Error(prepared.message);
          }
          if (prepared.acknowledgement.restored !== true) {
            await prepared.session.detach();
            throw new Error(
              "the exact interactive attach did not restore the coding-agent PTY",
            );
          }
          const after = await readStatus(options);
          if (after.state !== "running") {
            await prepared.session.detach();
            throw new Error(
              "the exact interactive agent exited while its terminal attached",
            );
          }
          const terminal = bindTangleInteractiveControl(
            prepared.session,
            exactRequest.control,
          );
          return terminal;
        },
        async sendPrompt(
          command: AgentInteractiveSessionPromptCommand,
          options?: { signal?: AbortSignal },
        ): Promise<AgentInteractiveSessionPromptAcknowledgement> {
          assertOptionKeys(options, ["signal"], "Tangle interactive agent prompt");
          const exactCommand = AgentInteractiveSessionPromptCommandSchema.parse(
            command,
          );
          assertRef(ref, exactCommand.ref);
          await validateControl(exactCommand.control, options);
          let raw;
          try {
            raw = await handle.sendPrompt(exactCommand);
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(transportFailureReason("interactive prompt", error));
          }
          options?.signal?.throwIfAborted();
          const acknowledgement =
            AgentInteractiveSessionPromptAcknowledgementSchema.parse(raw);
          if (
            !agentInteractiveSessionPromptAcknowledgementMatchesCommand(
              exactCommand,
              acknowledgement,
            )
          ) {
            throw new Error(
              "the Sandbox returned a prompt acknowledgement for another request",
            );
          }
          return acknowledgement;
        },
        async stop(
          command: AgentInteractiveSessionStopCommand,
          options?: { signal?: AbortSignal },
        ): Promise<AgentInteractiveSessionStopAcknowledgement> {
          assertOptionKeys(options, ["signal"], "Tangle interactive agent stop");
          const exactCommand = AgentInteractiveSessionStopCommandSchema.parse(
            command,
          );
          assertRef(ref, exactCommand.ref);
          await validateControl(exactCommand.control, options);
          let raw;
          try {
            raw = await handle.stop(exactCommand);
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(transportFailureReason("interactive stop", error));
          }
          options?.signal?.throwIfAborted();
          const acknowledgement =
            AgentInteractiveSessionStopAcknowledgementSchema.parse(raw);
          if (
            !agentInteractiveSessionStopAcknowledgementMatchesCommand(
              exactCommand,
              acknowledgement,
            )
          ) {
            throw new Error(
              "the Sandbox returned a stop acknowledgement for another request",
            );
          }
          return acknowledgement;
        },
      };
    },
  };
}

function isSandboxInteractiveSession(
  value: unknown,
): value is SandboxInteractiveSessionLike {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return [
    "start",
    "claimControl",
    "status",
    "attach",
    "validateControl",
    "sendPrompt",
    "stop",
  ].every((key) => typeof candidate[key] === "function");
}

function refFromStart(
  request: AgentInteractiveSessionStart,
  observed: Awaited<ReturnType<SandboxInteractiveSessionLike["start"]>>,
): AgentInteractiveSessionRef {
  if (
    observed.sessionId !== request.run.sessionId ||
    observed.harness !== request.profile.harness
  ) {
    throw new Error("the Sandbox returned a different interactive session identity");
  }
  return AgentInteractiveSessionRefSchema.parse({
    run: request.run,
    preparationReceipt: observed.preparationReceipt,
    incarnationId: observed.incarnationId,
    startedAt: observed.startedAt,
  });
}

function statusFromSandbox(
  ref: AgentInteractiveSessionRef,
  observed: SandboxInteractiveSessionStatusLike | null,
): AgentInteractiveSessionStatus {
  if (observed === null) {
    return AgentInteractiveSessionStatusSchema.parse({
      state: "unknown",
      ref,
      message: "the Sandbox no longer knows this interactive agent session",
      retryable: false,
    });
  }
  const observedRef = AgentInteractiveSessionRefSchema.parse({
    run: { ...ref.run, sessionId: observed.sessionId },
    preparationReceipt: observed.preparationReceipt,
    incarnationId: observed.incarnationId,
    startedAt: observed.startedAt,
  });
  if (
    observed.harness !== ref.preparationReceipt.harness ||
    !sameExactSessionRef(ref, observedRef)
  ) {
    throw new Error(
      "the Sandbox reported a different interactive agent session identity",
    );
  }
  if (observed.state === "running") {
    if (observed.streamUrl.length === 0) {
      throw new Error("the Sandbox reported a running session without a stream");
    }
    return AgentInteractiveSessionStatusSchema.parse({ state: "running", ref });
  }
  return AgentInteractiveSessionStatusSchema.parse({
    state: "exited",
    ref,
    endedAt: observed.endedAt,
    reason: observed.reason,
    ...(Number.isSafeInteger(observed.exitCode)
      ? { exitCode: observed.exitCode }
      : {}),
    ...(typeof observed.exitSignal === "string" && observed.exitSignal.length > 0
      ? { exitSignal: observed.exitSignal }
      : {}),
  });
}

function sameExactSessionRef(
  expected: AgentInteractiveSessionRef,
  candidate: AgentInteractiveSessionRef,
): boolean {
  return canonicalCandidateDigest(expected) === canonicalCandidateDigest(candidate);
}
