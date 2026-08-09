import { InteractionKind, PermissionGrantSchema, PERMISSION_GRANT_FIELD, type PermissionGrant } from "./interaction-permissions.js";
import { validateInteractionAnswer } from "./interaction-answer-validation.js";
import type { InteractionResolution } from "./interaction-data.js";
import type { InteractionAnswerSpec, InteractionResponseScope } from "./interaction-fields.js";

type InteractionResolutionRequest = {
  kind: string;
  answerSpec: InteractionAnswerSpec;
  responseScopes?: InteractionResponseScope[];
};

/**
 * A declined or cancelled resolution submits no answer, so any secret-typed
 * field it carries can only be leakage into a transport that retains it.
 */
function secretFieldErrors(
  spec: InteractionAnswerSpec,
  resolution: InteractionResolution,
): string[] {
  const secretFields = new Set(
    spec.fields
      .filter((field) => field.type === "secret")
      .map((field) => field.name),
  );
  return Object.keys(resolution.data ?? {})
    .filter((fieldName) => secretFields.has(fieldName))
    .map(
      (fieldName) =>
        `field "${fieldName}" is secret and cannot ride a ${resolution.outcome} resolution`,
    );
}

export function validateResolutionForRequest(
  request: InteractionResolutionRequest,
  resolution: InteractionResolution,
): string[] {
  if (resolution.outcome !== "accepted") {
    const errors = secretFieldErrors(request.answerSpec, resolution);
    if (Object.keys(resolution.data ?? {}).length > 0) {
      errors.push(
        `a ${resolution.outcome} resolution cannot carry answer fields`,
      );
    }
    return errors;
  }
  const validation = validateInteractionAnswer(
    request.answerSpec,
    resolution.data,
  );
  const errors = validation.ok ? [] : [...validation.errors];
  if (request.kind !== InteractionKind.Permission) return errors;

  const grant = resolution.data?.[PERMISSION_GRANT_FIELD];
  if (!Array.isArray(grant) || grant.length !== 1) {
    errors.push('permission response must select exactly one "grant" value');
    return errors;
  }
  const parsedGrant = PermissionGrantSchema.safeParse(grant[0]);
  if (!parsedGrant.success) {
    errors.push(`permission response has invalid grant "${String(grant[0])}"`);
    return errors;
  }
  if (parsedGrant.data === "deny") return errors;
  const requiredScope: Record<PermissionGrant, InteractionResponseScope> = {
    allow_once: "interaction",
    allow_session: "session",
    allow_always: "persistent",
    deny: "interaction",
  };
  const permitted = new Set(request.responseScopes ?? ["interaction"]);
  if (!permitted.has(requiredScope[parsedGrant.data])) {
    errors.push(
      `permission grant "${parsedGrant.data}" exceeds the request's response scopes`,
    );
  }
  return errors;
}
