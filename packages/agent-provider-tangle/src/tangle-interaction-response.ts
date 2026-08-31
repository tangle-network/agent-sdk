import {
  InteractionAcknowledgementSchema,
  InteractionRequestSchema,
  InteractionResponseCommandSchema,
  validateInteractionResponse,
} from "@tangle-network/agent-interface";
import type {
  InteractionAcknowledgement,
  InteractionAcknowledgementStatus,
  InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import type {
  SandboxInteractionCommandResultLike,
  SandboxSessionLike,
} from "./tangle-types.js";
import { awaitWithSignal } from "./tangle-contract-safety.js";
import { assertOptionKeys } from "./tangle-environment-validation.js";

export interface TangleInteractionResponderOptions {
  session: SandboxSessionLike;
  /** The session the bound ask must belong to. */
  sessionId: string;
  environmentId: string;
}

/**
 * Build one acknowledgement for a command this adapter refuses on its own.
 *
 * The three identity members echo the command, so a caller matches the answer
 * to the operation it sent. Optional members are written only when a value
 * exists: the schema demands a message for the two statuses that cannot be
 * read without one, and an absent `retryable` is a distinct fact from `false`.
 */
function acknowledge(
  command: InteractionResponseCommand,
  status: InteractionAcknowledgementStatus,
  extras: { message?: string; retryable?: boolean } = {},
): InteractionAcknowledgement {
  return InteractionAcknowledgementSchema.parse({
    operationId: command.operationId,
    binding: command.binding,
    commandDigest: command.commandDigest,
    status,
    ...(extras.message === undefined ? {} : { message: extras.message }),
    ...(extras.retryable === undefined ? {} : { retryable: extras.retryable }),
  });
}

/**
 * The coordinates this environment can answer for before the command reaches
 * the deployment. Tangle hosts a backend adapter inside the sandbox, so the
 * interaction binding's provider names that inner adapter (for example,
 * `opencode`) rather than this outer provider. The deployment compares that
 * provider with its durable interaction record. Environment and session are
 * still checked here because the Sandbox SDK rejects those coordinates before
 * it can return an acknowledgement.
 */
function foreignBinding(
  command: InteractionResponseCommand,
  options: TangleInteractionResponderOptions,
): InteractionAcknowledgement | undefined {
  const binding = command.binding;
  if (
    binding.environmentId === options.environmentId &&
    binding.sessionId === options.sessionId
  ) {
    return undefined;
  }
  return acknowledge(command, "binding_mismatch", {
    message: `response command binding names another environment or session than ${options.environmentId}/${options.sessionId}`,
  });
}

/**
 * Refuse an answer the outstanding ask does not accept, naming every field the
 * spec rejected.
 *
 * The deployment validates the same answer and is the authority, so this check
 * exists for the message: a refusal that names the missing field reaches the
 * caller instead of a bare rejection. It never invents a value for a field the
 * caller left out — an incomplete answer is refused whole.
 *
 * An ask absent from the outstanding set is not refused here. It is the shape
 * every already-resolved ask takes, and the deployment's durable record is the
 * only thing that can tell a replay from an ask that never existed.
 */
async function specRefusal(
  command: InteractionResponseCommand,
  options: TangleInteractionResponderOptions,
  signal?: AbortSignal,
): Promise<InteractionAcknowledgement | undefined> {
  if (typeof options.session.interactions !== "function") return undefined;
  let outstanding: readonly unknown[];
  try {
    outstanding = await awaitWithSignal(
      options.session.interactions(signal ? { signal } : undefined),
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    // The outstanding set is unreadable, so the spec cannot be checked here.
    // The command still carries only what the caller supplied, and the
    // deployment validates it against the same spec before any delivery.
    console.warn(
      `Tangle interaction spec read failed for session ${options.sessionId}: the answer reaches the deployment unchecked`,
      error,
    );
    return undefined;
  }
  signal?.throwIfAborted();
  if (!Array.isArray(outstanding)) return undefined;
  const interactionId = command.binding.interactionId;
  for (const entry of outstanding) {
    const parsed = InteractionRequestSchema.safeParse(entry);
    if (!parsed.success || parsed.data.id !== interactionId) continue;
    const validation = validateInteractionResponse(parsed.data, command.response);
    if (validation.ok) return undefined;
    return acknowledge(command, "invalid_response", {
      message: `interaction ${interactionId} rejected this answer: ${validation.errors.join("; ")}`,
    });
  }
  return undefined;
}

/** Read the digest a conflicting resolution already holds, when it carries one. */
function existingResponseDigest(
  result: SandboxInteractionCommandResultLike,
): string | undefined {
  const digest = result.serverResult?.existingResponseDigest;
  return typeof digest === "string" && digest.length > 0 ? digest : undefined;
}

/**
 * Whether the deployment recorded the response without confirming it reached
 * the waiting agent. A recorded-but-undelivered resolution is not an accepted
 * one, and reporting it as accepted would tell a caller an agent was released
 * that is still blocked.
 */
function unconfirmedDelivery(
  result: SandboxInteractionCommandResultLike,
): boolean {
  return result.serverResult?.delivered === false;
}

/**
 * Answer one exact interaction through the Sandbox interaction command route.
 *
 * The route carries the canonical command whole and returns the deployment's
 * own durable record, so this adapter keeps no resolution record of its own:
 * the deployment decides `accepted`, `already_resolved_same`, and
 * `already_resolved_different`, and its answer survives a restart of this
 * process and a rebuilt environment object. The capability this responder is
 * gated on is exactly that durable record.
 *
 * Two verdicts stay here, because the route cannot produce them as an
 * acknowledgement: a command bound to another environment or session, and an
 * answer the outstanding ask's spec rejects.
 */
export function tangleInteractionResponder(
  options: TangleInteractionResponderOptions,
): (
  command: InteractionResponseCommand,
  operation?: { signal?: AbortSignal },
) => Promise<InteractionAcknowledgement> {
  return async (
    command: InteractionResponseCommand,
    operation?: { signal?: AbortSignal },
  ): Promise<InteractionAcknowledgement> => {
    assertOptionKeys(operation, ["signal"], "Tangle interaction response");
    // A command whose digest does not cover its own content is malformed, not
    // refused: no acknowledgement can bind to a digest that names nothing.
    const exactCommand = InteractionResponseCommandSchema.parse(command);
    operation?.signal?.throwIfAborted();

    const foreign = foreignBinding(exactCommand, options);
    if (foreign) return foreign;

    const respond = options.session.respondToInteraction;
    if (typeof respond !== "function") {
      throw new Error(
        "Tangle sandbox session cannot deliver an interaction response command",
      );
    }

    const refusal = await specRefusal(exactCommand, options, operation?.signal);
    if (refusal) return refusal;

    const result = await awaitWithSignal(
      respond.call(
        options.session,
        exactCommand,
        operation?.signal ? { signal: operation.signal } : undefined,
      ),
      operation?.signal,
    );
    operation?.signal?.throwIfAborted();

    const acknowledgement = InteractionAcknowledgementSchema.parse(
      result?.acknowledgement,
    );
    if (
      acknowledgement.operationId !== exactCommand.operationId ||
      acknowledgement.commandDigest !== exactCommand.commandDigest ||
      acknowledgement.binding.interactionId !==
        exactCommand.binding.interactionId ||
      acknowledgement.binding.requestDigest !==
        exactCommand.binding.requestDigest ||
      acknowledgement.binding.sessionId !== exactCommand.binding.sessionId ||
      acknowledgement.binding.environmentId !==
        exactCommand.binding.environmentId ||
      acknowledgement.binding.runId !== exactCommand.binding.runId ||
      acknowledgement.binding.executionId !== exactCommand.binding.executionId ||
      acknowledgement.binding.provider !== exactCommand.binding.provider
    ) {
      throw new Error(
        "Tangle interaction response returned an acknowledgement for another operation",
      );
    }

    if (acknowledgement.status === "accepted" && unconfirmedDelivery(result)) {
      // The deployment recorded the resolution and did not confirm it reached
      // the ask. The record makes a retry safe, and the caller must not read
      // this as an answered ask.
      return acknowledge(exactCommand, "transport_failure", {
        message: `interaction ${exactCommand.binding.interactionId} is recorded but delivery is not confirmed`,
        retryable: true,
      });
    }

    if (acknowledgement.status === "already_resolved_different") {
      const digest = existingResponseDigest(result);
      if (digest !== undefined && !(acknowledgement.message ?? "").includes(digest)) {
        return acknowledge(exactCommand, "already_resolved_different", {
          message: `${
            acknowledgement.message ??
            `interaction ${exactCommand.binding.interactionId} already holds another response`
          } (existing response digest ${digest})`,
          ...(acknowledgement.retryable === undefined
            ? {}
            : { retryable: acknowledgement.retryable }),
        });
      }
    }

    return acknowledgement;
  };
}
