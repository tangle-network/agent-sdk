import type {
  AgentSessionRef,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import type { PromptOptions } from "@tangle-network/sandbox";
import type { SandboxInstanceLike } from "./tangle-types.js";
import {
  promptFromTurnInput,
  promptOptionsFromTurnInput,
} from "./tangle-prompt.js";
import {
  retainedSessionControlRef,
  sessionPromptExecutionId,
  sessionPromptSessionId,
  sessionRefFromSandboxDispatch,
} from "./tangle-session-control.js";
import { awaitWithSignal } from "./tangle-contract-safety.js";
import {
  interruptAfterAbort,
  sessionPromptRequestDigest,
} from "./tangle-environment-control.js";
export function dispatchEnvironmentRun(
  box: SandboxInstanceLike,
  provider: string,
  environmentId: string,
  prepare: (options: PromptOptions) => Promise<PromptOptions>,
): (input: AgentTurnInput) => Promise<AgentSessionRef> {
  return async (input) => {
    input.signal?.throwIfAborted();
    const options = promptOptionsFromTurnInput(input, { provider, environmentId });
    const callerControlRef = options.runControlRef;
    const expectedSessionId =
      options.sessionId ??
      sessionPromptSessionId(provider, environmentId, input.turnId);
    if (expectedSessionId === undefined) {
      throw new Error(
        "Tangle detached dispatch requires an exact sessionId or turnId",
      );
    }
    const exactInput = { ...input, sessionId: expectedSessionId };
    const requestedExecutionId = options.executionId;
    const baseRequestDigest = sessionPromptRequestDigest(
      exactInput,
      provider,
      environmentId,
      expectedSessionId,
    );
    const expectedExecutionId =
      requestedExecutionId ?? sessionPromptExecutionId(baseRequestDigest);
    const requestDigest = sessionPromptRequestDigest(
      exactInput,
      provider,
      environmentId,
      expectedSessionId,
      { executionId: expectedExecutionId },
    );
    if (callerControlRef !== undefined) {
      if (callerControlRef.requestDigest !== requestDigest) {
        throw new Error(
          "Tangle prompt request digest conflicts with the control reference",
        );
      }
    }
    const runControlRef = retainedSessionControlRef(
      expectedSessionId,
      expectedExecutionId,
      provider,
      environmentId,
      requestDigest,
      callerControlRef?.runId,
    );
    const promise = box.dispatchPrompt?.(
      promptFromTurnInput(input),
      await prepare({
        ...options,
        sessionId: expectedSessionId,
        executionId: expectedExecutionId,
        runControlRef,
      }),
    );
    let dispatched: unknown;
    try {
      dispatched = await awaitWithSignal(promise, input.signal);
    } catch (error) {
      if (input.signal?.aborted && input.detach !== true && promise) {
        void promise
          .then((late) => {
            const lateRef = sessionRefFromSandboxDispatch(
              late,
              provider,
              environmentId,
              expectedExecutionId,
              requestDigest,
              expectedSessionId,
              callerControlRef,
            );
            return interruptAfterAbort(box, lateRef);
          })
          .catch(() => undefined);
      }
      throw error;
    }
    const receipt = dispatched as Record<string, unknown> | undefined;
    if (receipt?.dispatched === false && receipt.alreadyExisted === true &&
        receipt.sessionId === expectedSessionId && receipt.executionId === expectedExecutionId &&
        receipt.runControlRef === undefined && callerControlRef === undefined && box.session) {
      // Recover an older SDK's omitted reuse reference from server status; validate every binding below.
      const status = await awaitWithSignal(box.session(expectedSessionId).status({ signal: input.signal }), input.signal);
      const echoedRef = status && typeof status === "object" && !Array.isArray(status) && "runControlRef" in status ? status.runControlRef : undefined;
      if (echoedRef !== undefined) dispatched = { ...receipt, runControlRef: echoedRef };
    }
    let reference: AgentSessionRef;
    try {
      reference = sessionRefFromSandboxDispatch(
        dispatched,
        provider,
        environmentId,
        expectedExecutionId,
        requestDigest,
        expectedSessionId,
        callerControlRef,
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
    if (input.signal?.aborted && input.detach !== true) {
      await interruptAfterAbort(box, reference);
    }
    input.signal?.throwIfAborted();
    return reference;
  };
}
