import {
  InteractionRequestSchema,
  InteractionResponseCommandSchema,
  InteractionResponseSchema,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionResponseCommand,
} from "./interaction-envelope.js";
import { type InteractionValidation } from "./interaction-answer-validation.js";
import { validateResolutionForRequest } from "./interaction-resolution-validation.js";

const FORBIDDEN_DATA_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type InteractionResponseValidation =
  | { ok: true; response: InteractionResponse }
  | { ok: false; errors: string[] };

function validResponse(
  response: InteractionResponse,
): Extract<InteractionResponseValidation, { ok: true }> {
  const result = { ok: true } as Extract<InteractionResponseValidation, { ok: true }>;
  Object.defineProperty(result, "response", {
    value: response,
    enumerable: false,
    writable: false,
  });
  return result;
}

function forbiddenKeyErrors(response: unknown): string[] {
  if (!response || typeof response !== "object") return [];
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  return Object.getOwnPropertyNames(data)
    .filter((key) => FORBIDDEN_DATA_KEYS.has(key))
    .map((key) => `unknown field "${key}"`);
}

/** Validate one response against the exact outstanding request. */
export function validateInteractionResponse(
  request: InteractionRequest,
  response: unknown,
): InteractionResponseValidation {
  const parsedRequest = InteractionRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return {
      ok: false,
      errors: parsedRequest.error.issues.map((issue) => issue.message),
    };
  }
  const exactRequest = parsedRequest.data;
  const forbidden = forbiddenKeyErrors(response);
  if (forbidden.length > 0) return { ok: false, errors: forbidden };

  const parsed = InteractionResponseSchema.safeParse(response);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => issue.message),
    };
  }
  if (exactRequest.id !== parsed.data.id) {
    return {
      ok: false,
      errors: ["response id does not match the outstanding interaction"],
    };
  }
  if (
    exactRequest.allowedOutcomes !== undefined &&
    !exactRequest.allowedOutcomes.includes(parsed.data.outcome)
  ) {
    return {
      ok: false,
      errors: ["response outcome is not allowed by the outstanding interaction"],
    };
  }
  const errors = validateResolutionForRequest(exactRequest, parsed.data);
  if (errors.length > 0) return { ok: false, errors };
  // Secret answers are ephemeral input for the provider call. The caller that
  // persists interaction records must redact them before journaling or tracing.
  return validResponse(parsed.data);
}

/** Validate a durable response command, including its run and request digest. */
export function validateInteractionResponseCommand(
  request: InteractionRequest,
  command: InteractionResponseCommand,
): InteractionResponseValidation {
  const parsedRequest = InteractionRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return {
      ok: false,
      errors: parsedRequest.error.issues.map((issue) => issue.message),
    };
  }
  const parsedCommand = InteractionResponseCommandSchema.safeParse(command);
  if (!parsedCommand.success) {
    return {
      ok: false,
      errors: parsedCommand.error.issues.map((issue) => issue.message),
    };
  }
  const binding = parsedCommand.data.binding;
  if (
    binding.requestDigest !== parsedRequest.data.requestDigest ||
    binding.runId !== parsedRequest.data.binding.runId ||
    binding.provider !== parsedRequest.data.binding.provider ||
    binding.environmentId !== parsedRequest.data.binding.environmentId ||
    binding.sessionId !== parsedRequest.data.binding.sessionId ||
    binding.executionId !== parsedRequest.data.binding.executionId ||
    binding.interactionId !== parsedRequest.data.binding.interactionId
  ) {
    return { ok: false, errors: ["response command binding is stale"] };
  }
  return validateInteractionResponse(parsedRequest.data, parsedCommand.data.response);
}

/** Parse and return the safe response for callers that need an enumerable result. */
export function validateAndParseInteractionResponse(
  request: InteractionRequest,
  response: unknown,
): InteractionResponseValidation {
  const result = validateInteractionResponse(request, response);
  if (!result.ok) return result;
  return { ok: true, response: result.response };
}

/** Verdict-only form for callers that never forward the value. */
export function interactionResponseIsValid(
  request: InteractionRequest,
  response: unknown,
): InteractionValidation {
  const result = validateInteractionResponse(request, response);
  return result.ok ? { ok: true } : { ok: false, errors: result.errors };
}
