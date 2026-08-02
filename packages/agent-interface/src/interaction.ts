/**
 * Interaction contract — the generalized human-in-the-loop primitive.
 *
 * An agent emits an `InteractionRequest`: a typed ask that carries a
 * self-describing `answerSpec` (the fields and types of a valid answer). A
 * human (or an automated policy) returns an `InteractionResponse` keyed by the
 * same `id`. This subsumes the original question/answer pair and extends it to
 * permissions, plans, and provider-specific asks.
 *
 * Design contract:
 * - The envelope is stable; `kind` is an OPEN label, so new ask types need no
 *   change to this contract. Well-known kinds (see `InteractionKind`) get
 *   richer rendering and platform handling; unknown kinds render generically
 *   from `answerSpec` and still work end-to-end.
 * - `answerSpec` is a small closed set of flat field types, so any consumer can
 *   render a form and validate a response without a general schema engine. This
 *   mirrors MCP elicitation so MCP-originated asks map onto this 1:1.
 * - `default` + `timeoutMs`/`onTimeout` make unattended resolution explicit and
 *   auditable, replacing blanket permission-bypass flags.
 */

import { z } from "zod";

// =============================================================================
// Answer specification — describes the shape of a valid answer.
// =============================================================================

const FieldBase = {
  /** Stable key the answer is returned under in `InteractionResponse.data`. */
  name: z.string().min(1),
  /** Human-readable label for the form control. */
  label: z.string().min(1),
  /** Whether the answer must supply this field to be `accepted`. */
  required: z.boolean().optional(),
};

export const InteractionFieldSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...FieldBase,
      type: z.literal("text"),
      multiline: z.boolean().optional(),
      placeholder: z.string().optional(),
      default: z.string().optional(),
    }),
    z.strictObject({
      ...FieldBase,
      type: z.literal("number"),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      default: z.number().finite().optional(),
    }),
    z.strictObject({
      ...FieldBase,
      type: z.literal("boolean"),
      default: z.boolean().optional(),
    }),
    z.strictObject({
      ...FieldBase,
      type: z.literal("select"),
      options: z
        .array(
          z.strictObject({
            value: z.string().min(1),
            label: z.string().min(1),
            description: z.string().optional(),
          }),
        )
        .min(1),
      /** When true the user may pick more than one option. */
      multi: z.boolean().optional(),
      /**
       * When true the answer may contain write-in values outside `options`
       * (e.g. a rendered "Other…" choice carrying the user's own text).
       * Write-ins must still be non-empty strings.
       */
      allowCustom: z.boolean().optional(),
      default: z.array(z.string().min(1)).optional(),
    }),
    /** Like `text` but the value is sensitive (token/key) and must be masked. */
    z.strictObject({
      ...FieldBase,
      type: z.literal("secret"),
      placeholder: z.string().optional(),
    }),
  ])
  .superRefine((field, context) => {
    if (field.type === "number") {
      if (
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      ) {
        context.addIssue({
          code: "custom",
          path: ["max"],
          message: "number field max must be greater than or equal to min",
        });
      }
      if (
        field.default !== undefined &&
        field.min !== undefined &&
        field.default < field.min
      ) {
        context.addIssue({
          code: "custom",
          path: ["default"],
          message: "number field default must be greater than or equal to min",
        });
      }
      if (
        field.default !== undefined &&
        field.max !== undefined &&
        field.default > field.max
      ) {
        context.addIssue({
          code: "custom",
          path: ["default"],
          message: "number field default must be less than or equal to max",
        });
      }
      return;
    }
    if (field.type !== "select") return;

    const optionValues = field.options.map((option) => option.value);
    if (new Set(optionValues).size !== optionValues.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "select option values must be unique",
      });
    }
    if (field.default === undefined) return;
    if (new Set(field.default).size !== field.default.length) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "select default values must be unique",
      });
    }
    if (!field.multi && field.default.length > 1) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "single-select default may contain at most one value",
      });
    }
    if (field.required && field.default.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "required select default must contain a value",
      });
    }
    const allowed = new Set(optionValues);
    for (const value of field.default) {
      if (allowed.has(value)) continue;
      if (field.allowCustom === true && value.trim().length > 0) continue;
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: `select default contains unknown option "${value}"`,
      });
    }
  });
export type InteractionField = z.infer<typeof InteractionFieldSchema>;

export const InteractionAnswerSpecSchema = z
  .strictObject({
    fields: z.array(InteractionFieldSchema),
  })
  .superRefine((spec, context) => {
    const names = spec.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        path: ["fields"],
        message: "interaction field names must be unique",
      });
    }
  });
export type InteractionAnswerSpec = z.infer<typeof InteractionAnswerSpecSchema>;

export const InteractionFieldTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "select",
  "secret",
]);
export type InteractionFieldType = z.infer<typeof InteractionFieldTypeSchema>;

/** Scope at which an accepted answer may be reused by an explicit policy. */
export const InteractionResponseScopeSchema = z.enum([
  "interaction",
  "session",
  "persistent",
]);
export type InteractionResponseScope = z.infer<
  typeof InteractionResponseScopeSchema
>;

/** Negotiated interaction behavior. Absence means interactions are unsupported. */
export const InteractionCapabilitiesSchema = z
  .strictObject({
    kinds: z.array(z.string().min(1)).min(1),
    answerFieldTypes: z.array(InteractionFieldTypeSchema).min(1),
    responseScopes: z.array(InteractionResponseScopeSchema).min(1),
    secretAnswers: z.boolean(),
    concurrentRequests: z.boolean(),
    replay: z.boolean(),
    responseIdempotency: z.boolean(),
  })
  .superRefine((capabilities, context) => {
    const advertisesSecret = capabilities.answerFieldTypes.includes("secret");
    if (advertisesSecret !== capabilities.secretAnswers) {
      context.addIssue({
        code: "custom",
        path: ["secretAnswers"],
        message:
          "secretAnswers must agree with the secret answer field capability",
      });
    }
    if (new Set(capabilities.kinds).size !== capabilities.kinds.length) {
      context.addIssue({
        code: "custom",
        path: ["kinds"],
        message: "interaction kinds must be unique",
      });
    }
    if (
      new Set(capabilities.answerFieldTypes).size !==
      capabilities.answerFieldTypes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["answerFieldTypes"],
        message: "interaction answer field types must be unique",
      });
    }
    if (
      new Set(capabilities.responseScopes).size !==
      capabilities.responseScopes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["responseScopes"],
        message: "interaction response scopes must be unique",
      });
    }
  });
export type InteractionCapabilities = z.infer<
  typeof InteractionCapabilitiesSchema
>;

// =============================================================================
// Subject — what the request is about (drives preview/permission UX).
// =============================================================================

export const InteractionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("tool"),
    toolName: z.string(),
    input: z.unknown().optional(),
  }),
  z.strictObject({ type: z.literal("command"), command: z.string() }),
  z.strictObject({
    type: z.literal("file"),
    path: z.string(),
    preview: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("resource"), uri: z.string() }),
]);
export type InteractionSubject = z.infer<typeof InteractionSubjectSchema>;

// =============================================================================
// Outcome + resolution — the answer.
// =============================================================================

export const InteractionOutcomeSchema = z.enum(["accepted", "declined", "cancelled"]);
export type InteractionOutcome = z.infer<typeof InteractionOutcomeSchema>;

/** Field values keyed by `InteractionField.name`. Validated against `answerSpec`. */
export const InteractionDataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
export type InteractionData = z.infer<typeof InteractionDataSchema>;

export const InteractionResolutionSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("accepted"),
    data: InteractionDataSchema.optional(),
  }),
  z.strictObject({
    outcome: z.literal("declined"),
    /** Accepted for wire compatibility; ignored by response validation. */
    data: InteractionDataSchema.optional(),
  }),
  z.strictObject({
    outcome: z.literal("cancelled"),
    /** Accepted for wire compatibility; ignored by response validation. */
    data: InteractionDataSchema.optional(),
  }),
]);
export type InteractionResolution = z.infer<typeof InteractionResolutionSchema>;

// =============================================================================
// The request envelope.
// =============================================================================

export const InteractionRequestSchema = z
  .strictObject({
    /** Correlation id; unique within a session. The response carries the same id. */
    id: z.string().min(1),
    /**
     * Open label for rendering, handling, and authorization. Well-known values:
     * `question` | `permission` | `plan`. Vendor extensions SHOULD namespace,
     * e.g. `x-pi.choose-extension`.
     */
    kind: z.string().min(1),
    /** Short human-readable prompt. */
    title: z.string().min(1),
    /** Optional longer context (markdown). */
    body: z.string().optional(),
    subject: InteractionSubjectSchema.optional(),
    answerSpec: InteractionAnswerSpecSchema,
    /** Omission is fail-closed and permits only this interaction. */
    responseScopes: z.array(InteractionResponseScopeSchema).min(1).optional(),
    /** Resolution applied when unattended or timed out — explicit, not a bypass flag. */
    default: InteractionResolutionSchema.optional(),
    /** Wait this long for a human before applying `onTimeout`. */
    timeoutMs: z.number().int().positive().optional(),
    /** On timeout: apply `default`, `fail` the turn, or keep `wait`ing. Default `wait`. */
    onTimeout: z.enum(["default", "fail", "wait"]).optional(),
  })
  .superRefine((request, context) => {
    if (
      request.responseScopes &&
      new Set(request.responseScopes).size !== request.responseScopes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["responseScopes"],
        message: "interaction response scopes must be unique",
      });
    }
    if (request.onTimeout === "default" && request.default === undefined) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "onTimeout=default requires a default resolution",
      });
    }
    if (request.default) {
      for (const error of validateResolutionForRequest(request, request.default)) {
        context.addIssue({ code: "custom", path: ["default"], message: error });
      }
      if (request.default.outcome === "accepted") {
        const secretFields = new Set(
          request.answerSpec.fields
            .filter((field) => field.type === "secret")
            .map((field) => field.name),
        );
        for (const fieldName of Object.keys(request.default.data ?? {})) {
          if (!secretFields.has(fieldName)) continue;
          context.addIssue({
            code: "custom",
            path: ["default", "data", fieldName],
            message: "secret answers cannot be embedded in interaction defaults",
          });
        }
      }
    }
  });
export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;

export const InteractionResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    id: z.string().min(1),
    outcome: z.literal("accepted"),
    data: InteractionDataSchema.optional(),
  }),
  z.strictObject({
    id: z.string().min(1),
    outcome: z.literal("declined"),
    /** Accepted for compatibility with the pre-discriminated wire shape. */
    data: InteractionDataSchema.optional(),
  }),
  z.strictObject({
    id: z.string().min(1),
    outcome: z.literal("cancelled"),
    /** Accepted for compatibility with the pre-discriminated wire shape. */
    data: InteractionDataSchema.optional(),
  }),
]);
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

/** A request is unique only within this run and optional provider session. */
export const InteractionBindingSchema = z.strictObject({
  runId: z.string().min(1),
  environmentId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  interactionId: z.string().min(1),
});
export type InteractionBinding = z.infer<typeof InteractionBindingSchema>;

/** Retryable command sent to an environment or retained session. */
export const InteractionResponseCommandSchema = z
  .strictObject({
    operationId: z.string().min(1),
    binding: InteractionBindingSchema,
    response: InteractionResponseSchema,
  })
  .superRefine((command, context) => {
    if (command.binding.interactionId !== command.response.id) {
      context.addIssue({
        code: "custom",
        path: ["response", "id"],
        message: "response id must match the bound interaction id",
      });
    }
  });
export type InteractionResponseCommand = z.infer<
  typeof InteractionResponseCommandSchema
>;

export const InteractionAcknowledgementStatusSchema = z.enum([
  "accepted",
  "already_resolved_same",
  "already_resolved_different",
  "expired",
  "cancelled",
  "unknown_interaction",
  "unknown_run",
  "binding_mismatch",
  "invalid_response",
  "transport_failure",
]);
export type InteractionAcknowledgementStatus = z.infer<
  typeof InteractionAcknowledgementStatusSchema
>;

/** Durable result of one interaction response operation. */
export const InteractionAcknowledgementSchema = z
  .strictObject({
    operationId: z.string().min(1),
    binding: InteractionBindingSchema,
    status: InteractionAcknowledgementStatusSchema,
    message: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
  })
  .superRefine((acknowledgement, context) => {
    if (
      ["invalid_response", "transport_failure"].includes(
        acknowledgement.status,
      ) &&
      acknowledgement.message === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: `${acknowledgement.status} must include a message`,
      });
    }
    if (
      acknowledgement.status === "transport_failure" &&
      acknowledgement.retryable === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "transport_failure must state whether retry is safe",
      });
    }
  });
export type InteractionAcknowledgement = z.infer<
  typeof InteractionAcknowledgementSchema
>;

// =============================================================================
// Well-known kinds + helpers.
// =============================================================================

export const InteractionKind = {
  /** Agent asks the user to answer/choose. Answer = the chosen field values. */
  Question: "question",
  /** Agent requests approval to run a tool/command. Answer = a `PermissionGrant`. */
  Permission: "permission",
  /** Agent shares a plan/todo list for review/approval. */
  Plan: "plan",
} as const;
export type WellKnownInteractionKind =
  (typeof InteractionKind)[keyof typeof InteractionKind];

/** Field name carrying the grant on a `permission` interaction's response. */
export const PERMISSION_GRANT_FIELD = "grant";
/** Optional free-text field carrying the user's reason on a `permission` response. */
export const PERMISSION_FEEDBACK_FIELD = "feedback";

/** Graduated permission decision — the value of the `grant` field. */
export const PermissionGrantSchema = z.enum([
  "allow_once",
  "allow_session",
  "allow_always",
  "deny",
]);
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

/** Build a permission answer spec that cannot offer a broader reusable grant. */
export function permissionAnswerSpec(opts?: {
  allowFeedback?: boolean;
  responseScopes?: readonly InteractionResponseScope[];
}): InteractionAnswerSpec {
  const scopes = new Set(opts?.responseScopes ?? ["interaction"]);
  const options = [
    ...(scopes.has("interaction")
      ? [{ value: "allow_once", label: "Allow once" }]
      : []),
    ...(scopes.has("session")
      ? [{ value: "allow_session", label: "Allow for this session" }]
      : []),
    ...(scopes.has("persistent")
      ? [{ value: "allow_always", label: "Always allow" }]
      : []),
    { value: "deny", label: "Deny" },
  ];
  const fields: InteractionField[] = [
    {
      type: "select",
      name: PERMISSION_GRANT_FIELD,
      label: "Decision",
      required: true,
      options,
    },
  ];
  if (opts?.allowFeedback !== false) {
    fields.push({
      type: "text",
      name: PERMISSION_FEEDBACK_FIELD,
      label: "Feedback (optional)",
      multiline: true,
    });
  }
  return { fields };
}

// =============================================================================
// Generic validation — does `data` satisfy `answerSpec`? Fail-closed.
// =============================================================================

export type InteractionValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate an accepted answer against its spec. Used by the broker before a
 * response reaches the adapter, so malformed answers are rejected centrally.
 */
export function validateInteractionAnswer(
  spec: InteractionAnswerSpec,
  data: InteractionData | undefined,
): InteractionValidation {
  const errors: string[] = [];
  const d = data ?? {};
  const knownFields = new Set(spec.fields.map((field) => field.name));
  for (const fieldName of Object.keys(d)) {
    if (!knownFields.has(fieldName)) {
      errors.push(`unknown field "${fieldName}"`);
    }
  }
  for (const field of spec.fields) {
    const v = d[field.name];
    const present = v !== undefined && v !== null && !(typeof v === "string" && v === "");
    if (!present) {
      if (field.required) errors.push(`missing required field "${field.name}"`);
      continue;
    }
    switch (field.type) {
      case "text":
      case "secret":
        if (typeof v !== "string") errors.push(`field "${field.name}" must be a string`);
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push(`field "${field.name}" must be a finite number`);
        } else {
          if (field.min !== undefined && v < field.min) errors.push(`field "${field.name}" below min ${field.min}`);
          if (field.max !== undefined && v > field.max) errors.push(`field "${field.name}" above max ${field.max}`);
        }
        break;
      case "boolean":
        if (typeof v !== "boolean") errors.push(`field "${field.name}" must be a boolean`);
        break;
      case "select": {
        if (!Array.isArray(v)) {
          errors.push(`field "${field.name}" must be an array of option values`);
          break;
        }
        if (!field.multi && v.length > 1) errors.push(`field "${field.name}" accepts a single value`);
        if (field.required && v.length === 0) errors.push(`field "${field.name}" requires a selection`);
        const allowed = new Set(field.options.map((o) => o.value));
        for (const choice of v) {
          if (allowed.has(choice)) continue;
          if (field.allowCustom === true) {
            // Write-ins are open but stay fail-closed on shape: string, non-blank.
            if (typeof choice !== "string" || choice.trim() === "") {
              errors.push(`field "${field.name}" has blank write-in value`);
            }
            continue;
          }
          errors.push(`field "${field.name}" has invalid option "${choice}"`);
        }
        break;
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Validate one response against the exact outstanding request. */
export function validateInteractionResponse(
  request: InteractionRequest,
  response: InteractionResponse,
): InteractionValidation {
  const parsed = InteractionResponseSchema.safeParse(response);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => issue.message),
    };
  }
  const errors =
    request.id === parsed.data.id
      ? validateResolutionForRequest(request, parsed.data)
      : ["response id does not match the outstanding interaction"];
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateResolutionForRequest(
  request: Pick<
    InteractionRequest,
    "kind" | "answerSpec" | "responseScopes"
  >,
  resolution: InteractionResolution,
): string[] {
  if (resolution.outcome !== "accepted") return [];
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
