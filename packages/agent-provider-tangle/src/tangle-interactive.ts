import {
  AgentInteractiveSessionAttachSchema,
  AgentInteractiveSessionControlClaimSchema,
  AgentInteractiveSessionControlClaimAcknowledgementSchema,
  AgentInteractiveSessionControlClaimRequestSchema,
  AgentInteractiveSessionPromptAcknowledgementSchema,
  AgentInteractiveSessionPromptCommandSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStatusSchema,
  AgentInteractiveSessionStopAcknowledgementSchema,
  AgentInteractiveSessionStopCommandSchema,
  TerminalReplayWindowSchema,
  TerminalSessionRefSchema,
  agentInteractiveSessionControlClaimAcknowledgementMatchesRequest,
  agentInteractiveSessionControlClaimMatchesRef,
  agentInteractiveSessionPromptAcknowledgementMatchesCommand,
  agentInteractiveSessionRefMatchesStart,
  agentInteractiveSessionStatusMatchesRef,
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
import { assertOptionKeys } from "./tangle-environment-validation.js";
import { transportFailureReason } from "./tangle-failure-reason.js";
import type {
  SandboxInstanceLike,
  SandboxInteractiveSessionLike,
} from "./tangle-types.js";

/** Exact coding-agent TUI operations for one sandbox environment. */
export interface TangleInteractiveAgentRegistry {
  start(
    request: AgentInteractiveSessionStart,
    options?: { signal?: AbortSignal }
  ): Promise<AgentInteractiveSessionRef>;
  get(ref: AgentInteractiveSessionRef): AgentInteractiveSession;
}

/**
 * Test the linked SDK surface without accepting any older interactive shape.
 *
 * Sandbox owns the exact reference, control claim, terminal binding, and
 * mutation acknowledgements. An older handle shape fails this test closed.
 */
export function sandboxBacksInteractiveAgent(
  box: SandboxInstanceLike
): boolean {
  if (typeof box.session !== "function") return false;
  try {
    const candidate = box
      .session("__tangle-interactive-probe__")
      .interactive?.();
    return isSandboxInteractiveSession(candidate);
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
  environmentId: string
): TangleInteractiveAgentRegistry {
  const exactHandle = (
    sessionId: string,
    binding?: {
      ref?: AgentInteractiveSessionRef;
      control?: AgentInteractiveSessionControlClaim;
    }
  ): SandboxInteractiveSessionLike => {
    const session = box.session?.(sessionId);
    const candidate = session?.interactive?.(binding);
    if (!isSandboxInteractiveSession(candidate)) {
      throw new Error(
        "the linked Sandbox SDK does not expose the exact interactive control API"
      );
    }
    return candidate;
  };

  const exactRef = (
    value: AgentInteractiveSessionRef
  ): AgentInteractiveSessionRef => {
    const ref = AgentInteractiveSessionRefSchema.parse(value);
    if (
      ref.run.provider !== providerName ||
      ref.run.environmentId !== environmentId
    ) {
      throw new Error(
        "the interactive agent reference belongs to a different environment"
      );
    }
    return ref;
  };

  const assertRef = (
    expected: AgentInteractiveSessionRef,
    candidate: AgentInteractiveSessionRef
  ): void => {
    if (!sameExactSessionRef(expected, candidate)) {
      throw new Error(
        "the Sandbox returned a different interactive session ref"
      );
    }
  };

  const assertControlMatchesRef = (
    ref: AgentInteractiveSessionRef,
    control: AgentInteractiveSessionControlClaim
  ): void => {
    if (!agentInteractiveSessionControlClaimMatchesRef(ref, control)) {
      throw new Error(
        "the interactive control claim belongs to another process"
      );
    }
  };

  const assertActiveControl = (
    ref: AgentInteractiveSessionRef,
    control: AgentInteractiveSessionControlClaim
  ): void => {
    assertControlMatchesRef(ref, control);
    if (Date.parse(control.expiresAt) <= Date.now()) {
      throw new Error("the interactive control claim has expired");
    }
  };

  return {
    async start(request, options): Promise<AgentInteractiveSessionRef> {
      assertOptionKeys(options, ["signal"], "Tangle interactive agent start");
      const exactRequest = exactAgentInteractiveSessionStart(request);
      if (exactRequest.profile.harness === undefined) {
        throw new Error(
          "interactive agent sessions require AgentProfile.harness"
        );
      }
      options?.signal?.throwIfAborted();
      const handle = exactHandle(exactRequest.run.sessionId);
      let observed;
      try {
        observed = await handle.start(exactRequest, options);
      } catch (error) {
        options?.signal?.throwIfAborted();
        throw new Error(transportFailureReason("interactive start", error));
      }
      options?.signal?.throwIfAborted();
      const ref = AgentInteractiveSessionRefSchema.parse(observed.ref);
      const control = AgentInteractiveSessionControlClaimSchema.parse(
        observed.control
      );
      if (!agentInteractiveSessionRefMatchesStart(exactRequest, ref)) {
        throw new Error(
          "the Sandbox returned an interactive session with a different admission receipt"
        );
      }
      assertControlMatchesRef(ref, control);
      if (observed.state === "running") assertActiveControl(ref, control);
      if (observed.state === "running" && observed.streamUrl.length === 0) {
        throw new Error(
          "the Sandbox returned a running session without a stream"
        );
      }
      return ref;
    },

    get(value): AgentInteractiveSession {
      const ref = exactRef(value);
      const handle = exactHandle(ref.run.sessionId, { ref });
      const mutationHandle = (
        control: AgentInteractiveSessionControlClaim
      ): SandboxInteractiveSessionLike =>
        exactHandle(ref.run.sessionId, { ref, control });
      const readStatus = async (options?: {
        signal?: AbortSignal;
      }): Promise<AgentInteractiveSessionStatus> => {
        assertOptionKeys(
          options,
          ["signal"],
          "Tangle interactive agent status"
        );
        options?.signal?.throwIfAborted();
        let observed;
        try {
          observed = await handle.status(options);
        } catch (error) {
          options?.signal?.throwIfAborted();
          throw new Error(transportFailureReason("interactive status", error));
        }
        options?.signal?.throwIfAborted();
        if (observed === null) {
          return AgentInteractiveSessionStatusSchema.parse({
            state: "unknown",
            ref,
            message:
              "the Sandbox no longer knows this interactive agent session",
            retryable: false,
          });
        }
        const status = AgentInteractiveSessionStatusSchema.parse(observed);
        if (!agentInteractiveSessionStatusMatchesRef(ref, status)) {
          throw new Error(
            "the Sandbox reported a different interactive agent session identity"
          );
        }
        return status;
      };

      const validateControl = async (
        control: AgentInteractiveSessionControlClaim,
        options?: { signal?: AbortSignal }
      ): Promise<void> => {
        assertActiveControl(ref, control);
        options?.signal?.throwIfAborted();
        try {
          await mutationHandle(control).validateControl(control, options);
        } catch (error) {
          options?.signal?.throwIfAborted();
          throw new Error(transportFailureReason("interactive control", error));
        }
        options?.signal?.throwIfAborted();
      };

      return {
        ref,
        async claimControl(request, options) {
          assertOptionKeys(
            options,
            ["signal"],
            "Tangle interactive control claim"
          );
          const exactRequest =
            AgentInteractiveSessionControlClaimRequestSchema.parse(request);
          assertRef(ref, exactRequest.ref);
          options?.signal?.throwIfAborted();
          let raw;
          try {
            raw = await handle.claimControl(exactRequest, options);
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(
              transportFailureReason("interactive control claim", error)
            );
          }
          options?.signal?.throwIfAborted();
          const acknowledgement =
            AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(raw);
          if (
            !agentInteractiveSessionControlClaimAcknowledgementMatchesRequest(
              exactRequest,
              acknowledgement
            )
          ) {
            throw new Error(
              "the Sandbox returned a control claim acknowledgement for another request"
            );
          }
          return acknowledgement;
        },
        status: readStatus,
        async attach(
          request,
          options
        ): Promise<AgentInteractiveTerminalSession> {
          assertOptionKeys(
            options,
            ["signal"],
            "Tangle interactive agent attach"
          );
          const exactRequest = AgentInteractiveSessionAttachSchema.parse(
            request ?? {}
          );
          await validateControl(exactRequest.control, options);
          let terminal: AgentInteractiveTerminalSession;
          try {
            terminal = await mutationHandle(
              exactRequest.control
            ).attachAgentTerminal(exactRequest, options);
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(
              transportFailureReason("interactive attach", error)
            );
          }
          try {
            options?.signal?.throwIfAborted();
            const returnedControl =
              AgentInteractiveSessionControlClaimSchema.parse(terminal.control);
            const returnedRef = TerminalSessionRefSchema.parse(terminal.ref);
            TerminalReplayWindowSchema.parse(terminal.cursors);
            if (
              canonicalCandidateDigest(returnedControl) !==
                canonicalCandidateDigest(exactRequest.control) ||
              returnedRef.terminalSessionId !== ref.run.sessionId ||
              returnedRef.parentExecutionId !== ref.run.executionId ||
              returnedRef.expiresAt !== exactRequest.control.expiresAt ||
              !returnedRef.isRunning
            ) {
              throw new Error(
                "the Sandbox returned a terminal with a different interactive identity"
              );
            }
          } catch (error) {
            await terminal.detach().catch(() => undefined);
            throw error;
          }
          return validatedTerminal(
            terminal,
            exactRequest.control,
            ref
          );
        },
        async sendPrompt(
          command: AgentInteractiveSessionPromptCommand,
          options?: { signal?: AbortSignal }
        ): Promise<AgentInteractiveSessionPromptAcknowledgement> {
          assertOptionKeys(
            options,
            ["signal"],
            "Tangle interactive agent prompt"
          );
          const exactCommand =
            AgentInteractiveSessionPromptCommandSchema.parse(command);
          assertRef(ref, exactCommand.ref);
          await validateControl(exactCommand.control, options);
          let raw;
          try {
            raw = await mutationHandle(exactCommand.control).sendPrompt(
              exactCommand,
              options
            );
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(
              transportFailureReason("interactive prompt", error)
            );
          }
          options?.signal?.throwIfAborted();
          const acknowledgement =
            AgentInteractiveSessionPromptAcknowledgementSchema.parse(raw);
          if (
            !agentInteractiveSessionPromptAcknowledgementMatchesCommand(
              exactCommand,
              acknowledgement
            )
          ) {
            throw new Error(
              "the Sandbox returned a prompt acknowledgement for another request"
            );
          }
          return acknowledgement;
        },
        async stop(
          command: AgentInteractiveSessionStopCommand,
          options?: { signal?: AbortSignal }
        ): Promise<AgentInteractiveSessionStopAcknowledgement> {
          assertOptionKeys(
            options,
            ["signal"],
            "Tangle interactive agent stop"
          );
          const exactCommand =
            AgentInteractiveSessionStopCommandSchema.parse(command);
          assertRef(ref, exactCommand.ref);
          await validateControl(exactCommand.control, options);
          let raw;
          try {
            raw = await mutationHandle(exactCommand.control).stop(
              exactCommand,
              options
            );
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
              acknowledgement
            )
          ) {
            throw new Error(
              "the Sandbox returned a stop acknowledgement for another request"
            );
          }
          return acknowledgement;
        },
      };
    },
  };
}

function isSandboxInteractiveSession(
  value: unknown
): value is SandboxInteractiveSessionLike {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return [
    "start",
    "claimControl",
    "status",
    "attachAgentTerminal",
    "validateControl",
    "sendPrompt",
    "stop",
  ].every((key) => typeof candidate[key] === "function");
}

function validatedTerminal(
  terminal: AgentInteractiveTerminalSession,
  control: AgentInteractiveSessionControlClaim,
  expectedRef: AgentInteractiveSessionRef
): AgentInteractiveTerminalSession {
  const boundControl = Object.freeze({ ...control });
  return {
    get ref() {
      const ref = TerminalSessionRefSchema.parse(terminal.ref);
      if (
        ref.terminalSessionId !== expectedRef.run.sessionId ||
        ref.parentExecutionId !== expectedRef.run.executionId
      ) {
        throw new Error(
          "the Sandbox terminal changed its interactive session identity"
        );
      }
      return ref;
    },
    get cursors() {
      return TerminalReplayWindowSchema.parse(terminal.cursors);
    },
    control: boundControl,
    // The authenticated terminal transport authorizes input and resize.
    // A REST preflight adds latency and can race the authoritative operation.
    input: (input, options) => terminal.input(input, options),
    resize: (resize, options) => terminal.resize(resize, options),
    detach: (options) => terminal.detach(options),
    close: (options) => terminal.close(options),
    events: (options) => terminal.events(options),
  };
}

function sameExactSessionRef(
  expected: AgentInteractiveSessionRef,
  candidate: AgentInteractiveSessionRef
): boolean {
  return (
    canonicalCandidateDigest(expected) === canonicalCandidateDigest(candidate)
  );
}
