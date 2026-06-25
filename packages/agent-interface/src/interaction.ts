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

export const InteractionFieldSchema = z.discriminatedUnion("type", [
  z.object({
    ...FieldBase,
    type: z.literal("text"),
    multiline: z.boolean().optional(),
    placeholder: z.string().optional(),
    default: z.string().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.number().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal("boolean"),
    default: z.boolean().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal("select"),
    options: z
      .array(
        z.object({
          value: z.string(),
          label: z.string(),
          description: z.string().optional(),
        }),
      )
      .min(1),
    /** When true the user may pick more than one option. */
    multi: z.boolean().optional(),
    default: z.array(z.string()).optional(),
  }),
  /** Like `text` but the value is sensitive (token/key) and must be masked. */
  z.object({
    ...FieldBase,
    type: z.literal("secret"),
    placeholder: z.string().optional(),
  }),
]);
export type InteractionField = z.infer<typeof InteractionFieldSchema>;

export const InteractionAnswerSpecSchema = z.object({
  fields: z.array(InteractionFieldSchema),
});
export type InteractionAnswerSpec = z.infer<typeof InteractionAnswerSpecSchema>;

// =============================================================================
// Subject — what the request is about (drives preview/permission UX).
// =============================================================================

export const InteractionSubjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), toolName: z.string(), input: z.unknown().optional() }),
  z.object({ type: z.literal("command"), command: z.string() }),
  z.object({ type: z.literal("file"), path: z.string(), preview: z.string().optional() }),
  z.object({ type: z.literal("resource"), uri: z.string() }),
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

export const InteractionResolutionSchema = z.object({
  outcome: InteractionOutcomeSchema,
  /** Present (and validated) only when `outcome === "accepted"`. */
  data: InteractionDataSchema.optional(),
});
export type InteractionResolution = z.infer<typeof InteractionResolutionSchema>;

// =============================================================================
// The request envelope.
// =============================================================================

export const InteractionRequestSchema = z.object({
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
  /** Resolution applied when unattended or timed out — explicit, not a bypass flag. */
  default: InteractionResolutionSchema.optional(),
  /** Wait this long for a human before applying `onTimeout`. */
  timeoutMs: z.number().int().positive().optional(),
  /** On timeout: apply `default`, `fail` the turn, or keep `wait`ing. Default `wait`. */
  onTimeout: z.enum(["default", "fail", "wait"]).optional(),
});
export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;

export const InteractionResponseSchema = InteractionResolutionSchema.extend({
  id: z.string().min(1),
});
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

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

/** Build the answer spec for a `permission` interaction (graduated grant + feedback). */
export function permissionAnswerSpec(opts?: { allowFeedback?: boolean }): InteractionAnswerSpec {
  const fields: InteractionField[] = [
    {
      type: "select",
      name: PERMISSION_GRANT_FIELD,
      label: "Decision",
      required: true,
      options: [
        { value: "allow_once", label: "Allow once" },
        { value: "allow_session", label: "Allow for this session" },
        { value: "allow_always", label: "Always allow" },
        { value: "deny", label: "Deny" },
      ],
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

/** Shape of one legacy question (kept for the back-compat shim). */
export type LegacyQuestion = {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

/**
 * Build an answer spec from the legacy `question` event shape. Each question
 * becomes one select field (free text when it declares no options), so the old
 * question/answer path is expressible as a `question` interaction.
 */
export function questionAnswerSpec(questions: LegacyQuestion[]): InteractionAnswerSpec {
  const fields: InteractionField[] = questions.map((q, i) => {
    const name = `q${i}`;
    if (q.options && q.options.length > 0) {
      return {
        type: "select",
        name,
        label: q.question,
        required: true,
        multi: q.multiSelect === true,
        options: q.options.map((o) => ({ value: o.label, label: o.label, description: o.description })),
      };
    }
    return { type: "text", name, label: q.question, required: true };
  });
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
        if (typeof v !== "number") {
          errors.push(`field "${field.name}" must be a number`);
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
          if (!allowed.has(choice)) errors.push(`field "${field.name}" has invalid option "${choice}"`);
        }
        break;
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
