import {
  canonicalCandidateDigest,
  InteractionAcknowledgementSchema,
  InteractionKind,
  InteractionResponseCommandSchema,
  PERMISSION_GRANT_FIELD,
  PermissionGrantSchema,
  validateInteractionResponse,
  type AgentExactRunControlRef,
  type InteractionAcknowledgement,
  type InteractionAcknowledgementStatus,
  type InteractionBinding,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import { assertOptionKeys } from "./tangle-environment-validation.js";
import { awaitWithSignal } from "./tangle-contract-safety.js";
import type {
  ObservedInteraction,
  TangleInteractionLedger,
} from "./tangle-interaction-ledger.js";
import type { SandboxSessionLike } from "./tangle-types.js";

/** Free-text field carrying the reviewer's reason on a rejected plan. */
const PLAN_FEEDBACK_FIELD = "feedback";

/** The Sandbox grant this adapter's transport can carry without downgrading it. */
const CARRIED_PERMISSION_GRANT = "allow_once";

/**
 * The Sandbox SDK's refusal when a session holds no outstanding question.
 * `SandboxSession.answer()` resolves the session's outstanding question, so it
 * fails with this exact message once the ask left the outstanding set.
 */
const NO_OUTSTANDING_QUESTION_MESSAGE =
  "No outstanding question to answer for this session";

/** The SDK error code that proves the request never reached the route. */
const SDK_NETWORK_ERROR_CODE = "NETWORK_ERROR";

export interface TangleInteractionResponderOptions {
  session: SandboxSessionLike;
  sessionId: string;
  provider: string;
  environmentId: string;
  ledger: TangleInteractionLedger;
  /** Exact run this session is bound to, when one is already established. */
  controlRef?: () => AgentExactRunControlRef | undefined;
}

export type TangleInteractionResponder = (
  command: InteractionResponseCommand,
  options?: { signal?: AbortSignal },
) => Promise<InteractionAcknowledgement>;

type AcknowledgementExtras = { message?: string; retryable?: boolean };

/** One refused command: the canonical status and the reason for it. */
interface Refusal {
  status: InteractionAcknowledgementStatus;
  extras: AcknowledgementExtras;
}

/** Canonical digest of the response material, matching the sidecar's ledger key. */
function responseMaterialDigest(response: InteractionResponse): string {
  return canonicalCandidateDigest(response);
}

function bindingOfObservedRequest(request: InteractionRequest): InteractionBinding {
  return { ...request.binding, requestDigest: request.requestDigest };
}

function errorStatusCode(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function errorConflictState(error: unknown): string | undefined {
  const state = (error as { currentState?: unknown } | null)?.currentState;
  return typeof state === "string" ? state : undefined;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : "Tangle interaction response failed";
}

/**
 * Translate one Sandbox SDK rejection into a canonical status.
 *
 * The interaction route's outcomes are the source; the SDK's error classes
 * carry the HTTP status and, for a 409, the sidecar's own conflict state.
 * `retryable` is claimed only from a shape that proves the request did not
 * reach the route or that the route asked for a retry: a transport error code,
 * a timeout, a rate limit, or a 5xx. Every other rejection, including one that
 * carries no status at all, is reported as terminal, because a retry of an
 * unattributed failure can land an answer on a later ask.
 */
function statusFromSandboxError(error: unknown): Refusal {
  const message = errorMessage(error);
  const code = errorStatusCode(error);
  if (message.includes(NO_OUTSTANDING_QUESTION_MESSAGE)) {
    // The runtime holds no outstanding question, so this ask left the
    // outstanding set: answered, withdrawn, or expired. Which of those is not
    // disclosed, so the adapter reports the ask as gone and claims no delivery.
    return { status: "unknown_interaction", extras: { message } };
  }
  if (code === 409) {
    const state = errorConflictState(error);
    if (state === "already_resolved_different") {
      return { status: "already_resolved_different", extras: { message } };
    }
    if (state === "binding_mismatch") {
      return { status: "binding_mismatch", extras: { message } };
    }
    return {
      status: "transport_failure",
      extras: { message, retryable: false },
    };
  }
  if (code === 404 || code === 410) {
    return { status: "unknown_interaction", extras: { message } };
  }
  if (code === 400) {
    return { status: "invalid_response", extras: { message } };
  }
  if (code === 501) {
    return { status: "transport_failure", extras: { message, retryable: false } };
  }
  const retryable =
    code === 408 ||
    code === 429 ||
    (code !== undefined && code >= 500) ||
    (code === undefined && errorCode(error) === SDK_NETWORK_ERROR_CODE);
  return { status: "transport_failure", extras: { message, retryable } };
}

/** Values the Sandbox question route accepts, keyed by answer field name. */
function questionAnswersFromResponse(
  response: InteractionResponse,
): Record<string, string[]> | undefined {
  const answers: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(response.data ?? {})) {
    if (typeof value === "string") {
      answers[field] = [value];
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      answers[field] = [String(value)];
      continue;
    }
    if (Array.isArray(value)) {
      answers[field] = value;
      continue;
    }
    // A one-use secret handle has no string form the question route accepts.
    return undefined;
  }
  return answers;
}

function permissionGrantOfResponse(response: InteractionResponse): string | undefined {
  const grant = (response.data ?? {})[PERMISSION_GRANT_FIELD];
  if (!Array.isArray(grant) || grant.length !== 1) return undefined;
  const parsed = PermissionGrantSchema.safeParse(grant[0]);
  return parsed.success ? parsed.data : undefined;
}

function planFeedbackOfResponse(response: InteractionResponse): string | undefined {
  const feedback = (response.data ?? {})[PLAN_FEEDBACK_FIELD];
  if (typeof feedback !== "string") return undefined;
  const trimmed = feedback.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function transportRefusal(message: string): Refusal {
  return { status: "transport_failure", extras: { message, retryable: false } };
}

/**
 * Answer outstanding interactions on one retained Sandbox session.
 *
 * Every answer is checked against the ask this adapter observed before any
 * request leaves the process: an unobserved id, a stale binding, a response the
 * ask's answer spec rejects, or a delivery this adapter cannot aim at the bound
 * ask is refused locally with the canonical status.
 *
 * The adapter's own resolution record answers a retry of a command it already
 * delivered. The record lives in the provider's ledger for the environment, so
 * it survives rebuilding the environment object with `provider.get()`. Beyond
 * the provider object the record is gone and the retry reaches the Sandbox
 * route, whose durable ledger the `interactions` claim requires: the agent
 * still receives one answer. A question then carries the runtime's own verdict
 * back, because an answered question is no longer outstanding and the SDK
 * refuses it. A permission does not: the route reports its replay in a body the
 * SDK discards, so that retry is acknowledged `accepted`.
 */
export function tangleInteractionResponder(
  options: TangleInteractionResponderOptions,
): TangleInteractionResponder {
  const { session, sessionId, provider, environmentId, ledger } = options;

  const acknowledge = (
    command: InteractionResponseCommand,
    status: InteractionAcknowledgementStatus,
    extras: AcknowledgementExtras = {},
  ): InteractionAcknowledgement =>
    InteractionAcknowledgementSchema.parse({
      operationId: command.operationId,
      binding: command.binding,
      commandDigest: command.commandDigest,
      status,
      ...(extras.message === undefined ? {} : { message: extras.message }),
      ...(extras.retryable === undefined ? {} : { retryable: extras.retryable }),
    });

  /** Coordinate check against the exact ask, fail-closed on every field. */
  const bindingVerdict = (
    command: InteractionResponseCommand,
    observed: ObservedInteraction,
  ): Refusal | undefined => {
    const binding = command.binding;
    const stale: AcknowledgementExtras = {
      message: `response command binding is stale for interaction ${binding.interactionId}`,
    };
    if (binding.provider !== provider || binding.environmentId !== environmentId) {
      return { status: "binding_mismatch", extras: stale };
    }
    if (binding.sessionId !== sessionId) {
      return { status: "binding_mismatch", extras: stale };
    }
    if (observed.request) {
      const expected = bindingOfObservedRequest(observed.request);
      if (binding.runId !== expected.runId) {
        return { status: "unknown_run", extras: stale };
      }
      if (
        binding.executionId !== expected.executionId ||
        binding.interactionId !== expected.interactionId ||
        binding.requestDigest !== expected.requestDigest
      ) {
        return { status: "binding_mismatch", extras: stale };
      }
      return undefined;
    }
    // A plan carries no request binding. Two coordinates can still prove its
    // run: the stream that carried the ask, and the run this session is bound
    // to. With neither, the adapter cannot tell this run from a foreign one,
    // so the response is refused instead of delivered on an unchecked binding.
    const carried = observed.run;
    const sessionRun = options.controlRef?.();
    const provenRunId = carried?.runId ?? sessionRun?.runId;
    const provenExecutionId = carried?.executionId ?? sessionRun?.executionId;
    if (provenRunId !== undefined && binding.runId !== provenRunId) {
      return { status: "unknown_run", extras: stale };
    }
    if (provenExecutionId === undefined) {
      return {
        status: "binding_mismatch",
        extras: {
          message: `interaction ${binding.interactionId} was observed on a stream bound to no exact run, so its binding cannot be checked`,
        },
      };
    }
    if (binding.executionId !== provenExecutionId) {
      return { status: "binding_mismatch", extras: stale };
    }
    return undefined;
  };

  /**
   * Prove that an untargeted question delivery lands on the bound ask.
   *
   * `SandboxSession.answer()` carries no interaction id: the SDK resolves the
   * session's outstanding question. This adapter therefore delivers only when
   * the ask it was asked to answer is the session's single unresolved
   * question, which is the transport limit the capability document declares as
   * `concurrentRequests: false`.
   */
  const questionTargetRefusal = (interactionId: string): Refusal | undefined => {
    const unresolved = ledger.unresolved(sessionId, InteractionKind.Question);
    if (unresolved.length === 1 && unresolved[0] === interactionId) {
      return undefined;
    }
    const others = unresolved.filter((id) => id !== interactionId);
    return {
      status: "binding_mismatch",
      extras: {
        message:
          others.length > 0
            ? `Tangle sessions answer the session's outstanding question and cannot select interaction ${interactionId} while ${others.join(", ")} is also unresolved`
            : `interaction ${interactionId} is not the session's outstanding question`,
      },
    };
  };

  const deliver = async (
    command: InteractionResponseCommand,
    observed: ObservedInteraction,
    signal?: AbortSignal,
  ): Promise<Refusal | undefined> => {
    const interactionId = command.binding.interactionId;
    const response = command.response;
    if (observed.kind === InteractionKind.Question) {
      if (response.outcome !== "accepted") {
        return transportRefusal(
          `Tangle sessions answer a question; they cannot submit a ${response.outcome} question resolution`,
        );
      }
      const answers = questionAnswersFromResponse(response);
      if (answers === undefined) {
        return transportRefusal(
          "Tangle sessions cannot carry a secret answer to a question",
        );
      }
      if (!session.answer) {
        return transportRefusal("Tangle sandbox session cannot answer questions");
      }
      const untargetable = questionTargetRefusal(interactionId);
      if (untargetable) return untargetable;
      await awaitWithSignal(session.answer(answers), signal);
      return undefined;
    }

    if (observed.kind === InteractionKind.Permission) {
      if (!session.respondToPermission) {
        return transportRefusal("Tangle sandbox session cannot resolve permissions");
      }
      if (response.outcome !== "accepted") {
        await awaitWithSignal(
          session.respondToPermission(interactionId, { response: "deny" }),
          signal,
        );
        return undefined;
      }
      const grant = permissionGrantOfResponse(response);
      if (grant === undefined) {
        return transportRefusal(
          'permission response must select exactly one "grant" value',
        );
      }
      if (grant === "deny") {
        await awaitWithSignal(
          session.respondToPermission(interactionId, { response: "deny" }),
          signal,
        );
        return undefined;
      }
      if (grant !== CARRIED_PERMISSION_GRANT) {
        // Sending "allow" would narrow a session or persistent grant to a
        // single use, which answers a different question than the one asked.
        return transportRefusal(
          `Tangle sessions carry the "${CARRIED_PERMISSION_GRANT}" grant only; "${grant}" cannot be delivered`,
        );
      }
      await awaitWithSignal(
        session.respondToPermission(interactionId, { response: "allow" }),
        signal,
      );
      return undefined;
    }

    if (observed.kind === InteractionKind.Plan) {
      if (!session.approvePlan || !session.rejectPlan) {
        return transportRefusal("Tangle sandbox session cannot decide plans");
      }
      if (response.outcome === "accepted") {
        await awaitWithSignal(session.approvePlan(interactionId), signal);
        return undefined;
      }
      const feedback = planFeedbackOfResponse(response);
      if (feedback === undefined) {
        return transportRefusal(
          `a ${response.outcome} plan resolution requires "${PLAN_FEEDBACK_FIELD}" text`,
        );
      }
      await awaitWithSignal(session.rejectPlan(feedback, interactionId), signal);
      return undefined;
    }

    return transportRefusal(
      `Tangle sessions cannot resolve a "${observed.kind}" interaction`,
    );
  };

  return async (
    command: InteractionResponseCommand,
    operation?: { signal?: AbortSignal },
  ): Promise<InteractionAcknowledgement> => {
    assertOptionKeys(operation, ["signal"], "Tangle interaction response");
    const exactCommand = InteractionResponseCommandSchema.parse(command);
    operation?.signal?.throwIfAborted();
    const interactionId = exactCommand.binding.interactionId;

    const recorded = ledger.resolution(sessionId, interactionId);
    if (recorded) {
      // The same operation replayed: return the acknowledgement it already
      // produced, byte for byte, instead of issuing a second delivery.
      if (
        recorded.operationId === exactCommand.operationId &&
        recorded.commandDigest === exactCommand.commandDigest
      ) {
        return recorded.acknowledgement;
      }
      if (recorded.responseDigest === responseMaterialDigest(exactCommand.response)) {
        return acknowledge(exactCommand, "already_resolved_same");
      }
      return acknowledge(exactCommand, "already_resolved_different", {
        message: `interaction ${interactionId} was already resolved with response digest ${recorded.responseDigest}`,
      });
    }

    const observed = ledger.observed(sessionId, interactionId);
    if (observed === undefined) {
      return acknowledge(exactCommand, "unknown_interaction", {
        message: `no observed interaction ${interactionId} on session ${sessionId}`,
      });
    }
    const mismatch = bindingVerdict(exactCommand, observed);
    if (mismatch !== undefined) {
      return acknowledge(exactCommand, mismatch.status, mismatch.extras);
    }
    if (observed.cancelled) {
      return acknowledge(exactCommand, "cancelled", {
        message: `interaction ${interactionId} was withdrawn before it was answered`,
      });
    }
    if (observed.request) {
      const validation = validateInteractionResponse(
        observed.request,
        exactCommand.response,
      );
      if (!validation.ok) {
        return acknowledge(exactCommand, "invalid_response", {
          message: `invalid answer: ${validation.errors.join("; ")}`,
        });
      }
    }

    let refusal: Refusal | undefined;
    try {
      refusal = await deliver(exactCommand, observed, operation?.signal);
    } catch (error) {
      if (operation?.signal?.aborted) throw error;
      const mapped = statusFromSandboxError(error);
      return acknowledge(exactCommand, mapped.status, mapped.extras);
    }
    // A refused delivery never becomes a resolution record: nothing was sent,
    // so a later command for the same ask must reach the same checks again.
    if (refusal !== undefined) {
      return acknowledge(exactCommand, refusal.status, refusal.extras);
    }
    operation?.signal?.throwIfAborted();
    // The Sandbox method reported the ask resolved without a body. The checks
    // above prove the ask was outstanding for this adapter, so this operation
    // is the one that resolved it.
    const acknowledgement = acknowledge(exactCommand, "accepted");
    ledger.record(sessionId, interactionId, {
      operationId: exactCommand.operationId,
      commandDigest: exactCommand.commandDigest,
      responseDigest: responseMaterialDigest(exactCommand.response),
      acknowledgement,
    });
    return acknowledgement;
  };
}
