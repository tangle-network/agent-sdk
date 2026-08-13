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

function errorExistingDigest(error: unknown): string | undefined {
  const digest = (error as { existingResponseDigest?: unknown } | null)
    ?.existingResponseDigest;
  return typeof digest === "string" && digest.length > 0 ? digest : undefined;
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
 * A status this adapter cannot attribute becomes `transport_failure`, never
 * a fabricated success or a guessed conflict.
 */
function statusFromSandboxError(error: unknown): {
  status: InteractionAcknowledgementStatus;
  extras: AcknowledgementExtras;
} {
  const message = errorMessage(error);
  const code = errorStatusCode(error);
  if (code === 409) {
    const state = errorConflictState(error);
    if (state === "already_resolved_different") {
      const existing = errorExistingDigest(error);
      return {
        status: "already_resolved_different",
        extras: {
          message: existing ? `${message} (existing ${existing})` : message,
        },
      };
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
  // A missing status is a transport-level failure (network, abort mid-flight);
  // a 5xx is the runtime failing to complete a well-formed request. Both are
  // safe to retry: the sidecar's durable ledger refuses a second delivery.
  return {
    status: "transport_failure",
    extras: { message, retryable: code === undefined || code >= 500 },
  };
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

/**
 * Answer outstanding interactions on one retained Sandbox session.
 *
 * Every answer is checked against the ask this adapter observed before any
 * request leaves the process: an unobserved id, a stale binding, or a response
 * the ask's answer spec rejects is refused locally with the canonical status.
 * The adapter's own resolution record answers a retry of a command it already
 * delivered, so a lost acknowledgement never re-delivers an answer.
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
  ): InteractionAcknowledgementStatus | undefined => {
    const binding = command.binding;
    if (binding.provider !== provider || binding.environmentId !== environmentId) {
      return "binding_mismatch";
    }
    if (binding.sessionId !== sessionId) return "binding_mismatch";
    if (observed.request) {
      const expected = bindingOfObservedRequest(observed.request);
      if (binding.runId !== expected.runId) return "unknown_run";
      if (
        binding.executionId !== expected.executionId ||
        binding.interactionId !== expected.interactionId ||
        binding.requestDigest !== expected.requestDigest
      ) {
        return "binding_mismatch";
      }
      return undefined;
    }
    // A plan carries no request binding. Hold it to the run this session is
    // bound to, which is the only exact coordinate the adapter can prove.
    const run = options.controlRef?.();
    if (run === undefined) return undefined;
    if (run.runId !== undefined && binding.runId !== run.runId) return "unknown_run";
    if (binding.executionId !== run.executionId) return "binding_mismatch";
    return undefined;
  };

  const deliver = async (
    command: InteractionResponseCommand,
    observed: ObservedInteraction,
    signal?: AbortSignal,
  ): Promise<InteractionAcknowledgementStatus | AcknowledgementExtras> => {
    const interactionId = command.binding.interactionId;
    const response = command.response;
    if (observed.kind === InteractionKind.Question) {
      if (response.outcome !== "accepted") {
        return {
          message: `Tangle sessions answer a question; they cannot submit a ${response.outcome} question resolution`,
          retryable: false,
        };
      }
      const answers = questionAnswersFromResponse(response);
      if (answers === undefined) {
        return {
          message: "Tangle sessions cannot carry a secret answer to a question",
          retryable: false,
        };
      }
      if (!session.answer) {
        return {
          message: "Tangle sandbox session cannot answer questions",
          retryable: false,
        };
      }
      await awaitWithSignal(session.answer(answers), signal);
      return "accepted";
    }

    if (observed.kind === InteractionKind.Permission) {
      if (!session.respondToPermission) {
        return {
          message: "Tangle sandbox session cannot resolve permissions",
          retryable: false,
        };
      }
      if (response.outcome !== "accepted") {
        await awaitWithSignal(
          session.respondToPermission(interactionId, { response: "deny" }),
          signal,
        );
        return "accepted";
      }
      const grant = permissionGrantOfResponse(response);
      if (grant === undefined) {
        return {
          message: 'permission response must select exactly one "grant" value',
          retryable: false,
        };
      }
      if (grant === "deny") {
        await awaitWithSignal(
          session.respondToPermission(interactionId, { response: "deny" }),
          signal,
        );
        return "accepted";
      }
      if (grant !== CARRIED_PERMISSION_GRANT) {
        // Sending "allow" would narrow a session or persistent grant to a
        // single use, which answers a different question than the one asked.
        return {
          message: `Tangle sessions carry the "${CARRIED_PERMISSION_GRANT}" grant only; "${grant}" cannot be delivered`,
          retryable: false,
        };
      }
      await awaitWithSignal(
        session.respondToPermission(interactionId, { response: "allow" }),
        signal,
      );
      return "accepted";
    }

    if (observed.kind === InteractionKind.Plan) {
      if (!session.approvePlan || !session.rejectPlan) {
        return {
          message: "Tangle sandbox session cannot decide plans",
          retryable: false,
        };
      }
      if (response.outcome === "accepted") {
        await awaitWithSignal(session.approvePlan(interactionId), signal);
        return "accepted";
      }
      const feedback = planFeedbackOfResponse(response);
      if (feedback === undefined) {
        return {
          message: `a ${response.outcome} plan resolution requires "${PLAN_FEEDBACK_FIELD}" text`,
          retryable: false,
        };
      }
      await awaitWithSignal(session.rejectPlan(feedback, interactionId), signal);
      return "accepted";
    }

    return {
      message: `Tangle sessions cannot resolve a "${observed.kind}" interaction`,
      retryable: false,
    };
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
      return acknowledge(exactCommand, mismatch, {
        message: `response command binding is stale for interaction ${interactionId}`,
      });
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

    let outcome: InteractionAcknowledgementStatus | AcknowledgementExtras;
    try {
      outcome = await deliver(exactCommand, observed, operation?.signal);
    } catch (error) {
      if (operation?.signal?.aborted) throw error;
      const mapped = statusFromSandboxError(error);
      return acknowledge(exactCommand, mapped.status, mapped.extras);
    }
    if (typeof outcome !== "string") {
      return acknowledge(exactCommand, "transport_failure", outcome);
    }
    operation?.signal?.throwIfAborted();
    // The Sandbox methods report resolution without a body, so a fresh
    // resolution and the sidecar's replay of an identical stored one are the
    // same observation. Both mean the ask now holds exactly this answer.
    const acknowledgement = acknowledge(exactCommand, outcome);
    ledger.record(sessionId, interactionId, {
      operationId: exactCommand.operationId,
      commandDigest: exactCommand.commandDigest,
      responseDigest: responseMaterialDigest(exactCommand.response),
      acknowledgement,
    });
    return acknowledgement;
  };
}
