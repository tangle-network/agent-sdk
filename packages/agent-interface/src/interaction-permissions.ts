import { z } from "zod";
import {
  CONTRACT_MAX_MAP_ENTRIES,
  boundedIdentifierSchema,
} from "./contract-limits.js";
import type { InteractionAnswerSpec, InteractionField, InteractionResponseScope } from "./interaction-fields.js";

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

/** Interaction kinds a provider may originate for one turn. */
export type RequestedInteractions = Readonly<Record<string, boolean | undefined>>;

const wellKnownInteractionKinds = new Set<string>(Object.values(InteractionKind));

const requestedInteractionKindSchema = boundedIdentifierSchema.refine(
  (value) =>
    wellKnownInteractionKinds.has(value) ||
    (value.includes(".") &&
      !value.startsWith(".") &&
      !value.endsWith(".") &&
      !value.includes("..")),
  "custom interaction kind must be namespaced",
);

/**
 * Bounded per-turn interaction posture.
 *
 * The well-known keys above provide portable behavior. Namespaced keys let a
 * provider extension use the same request, response, and replay protocol.
 */
export const RequestedInteractionsSchema = z
  .record(requestedInteractionKindSchema, z.boolean())
  .superRefine((value, context) => {
    if (Object.keys(value).length > CONTRACT_MAX_MAP_ENTRIES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `interaction posture exceeds ${CONTRACT_MAX_MAP_ENTRIES} kinds`,
      });
    }
  }) satisfies z.ZodType<RequestedInteractions>;

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
