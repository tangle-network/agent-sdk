import {
  AgentInteractiveSessionAttachSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStatusSchema,
  agentInteractiveSessionRefMatchesStart,
  agentInteractiveSessionStatusMatchesRef,
  exactAgentInteractiveSessionStart,
} from "@tangle-network/agent-interface";
import type {
  AgentInteractiveSession,
  AgentInteractiveSessionRef,
  AgentInteractiveSessionStart,
  AgentInteractiveSessionStatus,
  AgentTerminalSession,
} from "@tangle-network/agent-interface";
import { parseBackendType } from "@tangle-network/sandbox";
import {
  boundedString,
} from "./tangle-contract-safety.js";
import { assertOptionKeys } from "./tangle-environment-validation.js";
import { transportFailureReason } from "./tangle-failure-reason.js";
import {
  createTangleTerminalStreamCapture,
  prepareTangleTerminalAttachment,
} from "./tangle-terminal.js";
import type {
  SandboxInstanceLike,
  SandboxInteractiveSessionInfoLike,
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

/** True when the linked SDK can drive the complete exact interactive surface. */
export function sandboxBacksInteractiveAgent(box: SandboxInstanceLike): boolean {
  if (typeof box.session !== "function") return false;
  try {
    const interactive = box.session("__tangle-interactive-probe__").interactive?.();
    return (
      typeof interactive?.start === "function" &&
      typeof interactive.status === "function" &&
      typeof interactive.attach === "function" &&
      typeof interactive.sendPrompt === "function" &&
      typeof interactive.stop === "function" &&
      typeof box.terminals?.get === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Adapt Sandbox's existing native-TUI handle without creating another shell.
 *
 * Every reconstructed handle checks the provider, environment, session,
 * profile digest, harness, and start time before it returns live controls.
 */
export function createTangleInteractiveAgentRegistry(
  box: SandboxInstanceLike,
  providerName: string,
  environmentId: string,
): TangleInteractiveAgentRegistry {
  const exactHandle = (sessionId: string): SandboxInteractiveSessionLike => {
    const session = box.session?.(sessionId);
    const interactive = session?.interactive?.();
    if (
      interactive === undefined ||
      typeof interactive.start !== "function" ||
      typeof interactive.status !== "function" ||
      typeof interactive.attach !== "function" ||
      typeof interactive.sendPrompt !== "function" ||
      typeof interactive.stop !== "function"
    ) {
      throw new Error(
        "the Sandbox client exposes no exact interactive agent session",
      );
    }
    return interactive;
  };

  const exactRef = (
    value: AgentInteractiveSessionRef,
  ): AgentInteractiveSessionRef => {
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
      exactRef({
        run: exactRequest.run,
        profileDigest: exactRequest.profileDigest,
        harness: requestedHarness,
        startedAt: new Date(0).toISOString(),
      });
      options?.signal?.throwIfAborted();
      const handle = exactHandle(exactRequest.run.sessionId);
      let observed: SandboxInteractiveSessionInfoLike;
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
        });
      } catch (error) {
        options?.signal?.throwIfAborted();
        throw new Error(transportFailureReason("interactive start", error));
      }
      if (options?.signal?.aborted) {
        await stopAfterAbort(handle);
        options.signal.throwIfAborted();
      }
      let ref: AgentInteractiveSessionRef;
      try {
        ref = refFromStart(exactRequest, observed);
      } catch {
        return await stopAfterRejectedIdentity(
          handle,
          "the Sandbox started a malformed interactive agent session",
        );
      }
      if (!agentInteractiveSessionRefMatchesStart(exactRequest, ref)) {
        await stopAfterRejectedIdentity(
          handle,
          "the Sandbox started a different interactive agent session",
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

      return {
        ref,
        status: readStatus,
        async attach(request, options): Promise<AgentTerminalSession> {
          assertOptionKeys(options, ["signal"], "Tangle interactive agent attach");
          const exactRequest = AgentInteractiveSessionAttachSchema.parse(
            request ?? {},
          );
          options?.signal?.throwIfAborted();
          const before = await readStatus(options);
          if (before.state !== "running") {
            throw new Error(
              "the exact interactive agent session is not running",
            );
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
              ...exactRequest,
              handlers: capture.handlers,
            });
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(transportFailureReason("interactive attach", error));
          }
          if (options?.signal?.aborted) {
            await closeStreamQuietly(stream);
            options.signal.throwIfAborted();
          }
          const prepared = await prepareTangleTerminalAttachment({
            stream,
            capture,
            terminals,
            parentExecutionId: ref.run.executionId,
            expectedSessionId: ref.run.sessionId,
            signal: options?.signal,
          });
          if (prepared.status === "unknown") {
            throw new Error(prepared.message);
          }
          if (prepared.acknowledgement.restored !== true) {
            await prepared.session.detach();
            await stopAfterRejectedIdentity(
              handle,
              "the exact interactive attach created a new terminal",
            );
          }
          const after = await readStatus(options);
          if (after.state !== "running") {
            await prepared.session.detach();
            throw new Error(
              "the exact interactive agent exited while its terminal attached",
            );
          }
          return prepared.session;
        },
        async sendPrompt(prompt, options): Promise<void> {
          assertOptionKeys(options, ["signal"], "Tangle interactive agent prompt");
          const exactPrompt = boundedString(
            prompt,
            "Tangle interactive agent prompt",
          );
          if (exactPrompt.length === 0) {
            throw new Error("Tangle interactive agent prompt cannot be empty");
          }
          options?.signal?.throwIfAborted();
          try {
            await handle.sendPrompt(exactPrompt);
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(transportFailureReason("interactive prompt", error));
          }
          options?.signal?.throwIfAborted();
        },
        async stop(options): Promise<AgentInteractiveSessionStatus> {
          assertOptionKeys(options, ["signal"], "Tangle interactive agent stop");
          const before = await readStatus(options);
          if (before.state !== "running") return before;
          options?.signal?.throwIfAborted();
          try {
            await handle.stop();
          } catch (error) {
            options?.signal?.throwIfAborted();
            throw new Error(transportFailureReason("interactive stop", error));
          }
          options?.signal?.throwIfAborted();
          const after = await readStatus(options);
          if (after.state === "running") {
            return AgentInteractiveSessionStatusSchema.parse({
              state: "unknown",
              ref,
              message: "the Sandbox did not confirm the interactive agent stopped",
              retryable: true,
            });
          }
          return after;
        },
      };
    },
  };
}

function refFromStart(
  request: AgentInteractiveSessionStart,
  observed: SandboxInteractiveSessionInfoLike,
): AgentInteractiveSessionRef {
  if (observed.sessionId !== request.run.sessionId) {
    throw new Error("interactive agent session id mismatch");
  }
  return AgentInteractiveSessionRefSchema.parse({
    run: request.run,
    profileDigest: observed.profileDigest,
    harness: observed.harness,
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
    run: ref.run,
    profileDigest: observed.profileDigest,
    harness: observed.harness,
    startedAt: observed.startedAt,
  });
  if (
    observed.sessionId !== ref.run.sessionId ||
    !agentInteractiveSessionStatusMatchesRef(ref, {
      state: "running",
      ref: observedRef,
    })
  ) {
    throw new Error(
      "the Sandbox reported a different interactive agent session identity",
    );
  }
  if (observed.state === "running") {
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
    ...(typeof observed.exitSignal === "string" &&
    observed.exitSignal.length > 0
      ? { exitSignal: observed.exitSignal }
      : {}),
  });
}

async function stopAfterRejectedIdentity(
  handle: SandboxInteractiveSessionLike,
  message: string,
): Promise<never> {
  try {
    await handle.stop();
  } catch (error) {
    throw new Error(
      `${message}; ${transportFailureReason("interactive stop", error)}`,
    );
  }
  throw new Error(message);
}

async function stopAfterAbort(
  handle: SandboxInteractiveSessionLike,
): Promise<void> {
  try {
    await handle.stop();
  } catch (error) {
    throw new Error(
      `the aborted interactive agent could not be reaped; ${transportFailureReason(
        "interactive stop",
        error,
      )}`,
    );
  }
}

async function closeStreamQuietly(stream: SandboxTerminalStreamLike): Promise<void> {
  try {
    await stream.close();
  } catch {
    // The caller is already failing the attach. No live handle is returned.
  }
}
