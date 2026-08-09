import { AgentTurnInputSchema } from "@tangle-network/agent-interface";
import type {
  AgentSessionRef,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import type { SandboxInstanceLike } from "./tangle-types.js";
import {
  executionIdFromTurnInput,
  promptFromTurnInput,
  promptOptionsFromTurnInput,
} from "./tangle-prompt.js";
import { retainedSessionControlRef, sessionRefFromSandboxDispatch } from "./tangle-session-control.js";
import { awaitWithSignal } from "./tangle-contract-safety.js";
import {
  interruptAfterAbort,
  sessionPromptRequestDigest,
} from "./tangle-environment-control.js";

export function dispatchEnvironmentRun(
  box: SandboxInstanceLike,
  provider: string,
  environmentId: string,
): (input: AgentTurnInput) => Promise<AgentSessionRef> {
  return async (input) => {
    AgentTurnInputSchema.parse(input);
    input.signal?.throwIfAborted();
    const expectedSessionId = input.sessionId ?? input.controlRef?.sessionId;
    const promise = box.dispatchPrompt?.(
      promptFromTurnInput(input),
      promptOptionsFromTurnInput(input, { provider, environmentId }),
    );
    let dispatched: unknown;
    try {
      dispatched = await awaitWithSignal(promise, input.signal);
    } catch (error) {
      if (input.signal?.aborted && promise) {
        void promise
          .then((late) => {
            const lateRef = sessionRefFromSandboxDispatch(
              late,
              provider,
              environmentId,
              executionIdFromTurnInput(input),
            );
            return interruptAfterAbort(box, lateRef);
          })
          .catch(() => undefined);
      }
      throw error;
    }
    let reference: AgentSessionRef;
    try {
      reference = sessionRefFromSandboxDispatch(
        dispatched,
        provider,
        environmentId,
        executionIdFromTurnInput(input),
        undefined,
        expectedSessionId,
      );
    } catch (error) {
      try {
        const unexpected = sessionRefFromSandboxDispatch(
          dispatched,
          provider,
          environmentId,
          undefined,
        );
        if (
          unexpected.metadata?.dispatched === true &&
          unexpected.metadata.alreadyExisted !== true
        ) {
          await interruptAfterAbort(box, unexpected);
        }
      } catch {
        // An invalid receipt cannot identify a safe execution to interrupt.
      }
      throw error;
    }
    const executionId = reference.controlRef?.executionId;
    const requestDigest =
      executionId === undefined
        ? undefined
        : sessionPromptRequestDigest(
            input,
            provider,
            environmentId,
            reference.id,
            executionId,
          );
    const boundReference =
      executionId === undefined || requestDigest === undefined
        ? reference
        : {
            ...reference,
            controlRef: retainedSessionControlRef(
              reference.id,
              executionId,
              provider,
              environmentId,
              requestDigest,
            ),
          };
    if (input.signal?.aborted) {
      await interruptAfterAbort(box, boundReference);
      input.signal.throwIfAborted();
    }
    return boundReference;
  };
}
