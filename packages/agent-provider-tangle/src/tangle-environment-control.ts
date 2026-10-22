import { canonicalCandidateDigest } from "@tangle-network/agent-interface";
import type {
  AgentSessionRef,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  SandboxInstanceLike,
  SandboxSessionLike,
} from "./tangle-types.js";
import {
  backendFromTurnInput,
  backendRequestIdentity,
} from "./tangle-prompt.js";
import { awaitWithSignal } from "./tangle-contract-safety.js";
import { assertOptionKeys } from "./tangle-environment-validation.js";

/** Concurrent owners join one successful destroy; a failed request remains retryable. */
export function environmentDestruction(box: SandboxInstanceLike, ephemeral = false) {
  let destruction: Promise<void> | undefined;
  return async (options?: { signal?: AbortSignal }): Promise<void> => {
    if (!box.delete) throw new Error("Tangle sandbox client cannot delete this environment");
    assertOptionKeys(options, ["signal"], "Tangle destroy");
    options?.signal?.throwIfAborted();
    destruction ??= awaitWithSignal(box.delete(ephemeral ? { ...options, until: "removed" } : options), options?.signal)
      .then((receipt) => {
        if (!ephemeral) return;
        const proof = receipt as { outcome?: unknown; removal?: unknown } | null | undefined;
        if (!proof || !["destroyed", "already_absent"].includes(String(proof.outcome)) || (proof.removal !== undefined && proof.removal !== "complete")) {
          throw new Error("Tangle ephemeral sandbox removal was not confirmed");
        }
      })
      .catch((error: unknown) => { destruction = undefined; throw error; });
    await awaitWithSignal(destruction, options?.signal);
    options?.signal?.throwIfAborted();
  };
}

export function sessionPromptRequestDigest(
  input: AgentTurnInput,
  provider: string,
  environmentId: string,
  sessionId: string,
  options: { executionId?: string; nonce?: string } = {},
): `sha256:${string}` {
  const backend = backendRequestIdentity(
    backendFromTurnInput(input),
  );
  return canonicalCandidateDigest({
    provider,
    environmentId,
    sessionId,
    ...(options.executionId === undefined
      ? {}
      : { executionId: options.executionId }),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.parts === undefined ? {} : { parts: input.parts }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.detach === undefined ? {} : { detach: input.detach }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.interactions === undefined
      ? {}
      : { interactions: input.interactions }),
    // Per-turn backend options select the model, the profile, and the seat the
    // turn runs on. Leaving them out of the identity would let a retry under
    // the same turn id reuse work that ran on other settings. The bearer
    // material inside them is excluded, so a token refresh does not conflict
    // with the run it continues.
    ...(backend === undefined ? {} : { backend }),
  });
}

export function hasReplayPayload(input: AgentTurnInput): boolean {
  return (
    input.profile !== undefined ||
    input.prompt !== undefined ||
    input.parts !== undefined ||
    input.model !== undefined ||
    input.timeoutMs !== undefined ||
    input.turnId !== undefined ||
    input.detach !== undefined ||
    input.context !== undefined ||
    input.interactions !== undefined ||
    input.providerOptions !== undefined
  );
}

export async function interruptAfterAbort(
  box: SandboxInstanceLike,
  reference: AgentSessionRef,
): Promise<void> {
  const metadata = reference.metadata;
  // A duplicate dispatch receipt identifies work owned by another caller.
  // Only a receipt that proves this call admitted new work may be interrupted.
  if (metadata?.dispatched !== true || metadata.alreadyExisted === true) return;
  const executionId = reference.controlRef?.executionId;
  if (!box.session || executionId === undefined) return;
  await interruptExecutionAfterAbort(box, reference.id, executionId);
}

export async function interruptExecutionAfterAbort(
  source: SandboxInstanceLike | SandboxSessionLike,
  sessionId: string,
  executionId: string,
): Promise<void> {
  try {
    const target = "interrupt" in source
      ? source
      : source.session?.(sessionId);
    await target?.interrupt({ executionId });
  } catch {
    // The operation's abort remains the caller-visible result; cleanup is best effort.
  }
}
