import { z } from "zod";
import {
  canonicalCandidateDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  boundedIdentifierSchema,
  boundedJsonSchema,
  boundedStringSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
} from "./contract-limits.js";
import {
  InteractionDataSchema,
  InteractionResolutionSchema,
  type InteractionResolution,
} from "./interaction-data.js";
import {
  InteractionAnswerSpecSchema,
  InteractionResponseScopeSchema,
} from "./interaction-fields.js";
import { validateResolutionForRequest } from "./interaction-resolution-validation.js";

export {
  InteractionDataSchema,
  InteractionResolutionSchema,
  InteractionSecretReferenceSchema,
} from "./interaction-data.js";
export type {
  InteractionData,
  InteractionDataValue,
  InteractionResolution,
  InteractionSecretReference,
} from "./interaction-data.js";

const interactionOutcomeValues = ["accepted", "declined", "cancelled"] as const;

// =============================================================================
// Subject — what the request is about (drives preview/permission UX).
// =============================================================================

export const InteractionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("tool"),
    toolName: boundedIdentifierSchema,
    input: boundedJsonSchema.optional(),
  }),
  z.strictObject({ type: z.literal("command"), command: boundedStringSchema }),
  z.strictObject({
    type: z.literal("file"),
    path: boundedStringSchema,
    preview: boundedStringSchema.optional(),
  }),
  z.strictObject({ type: z.literal("resource"), uri: boundedStringSchema }),
]);
export type InteractionSubject = z.infer<typeof InteractionSubjectSchema>;

export const InteractionOutcomeSchema = z.enum(interactionOutcomeValues);
export type InteractionOutcome = z.infer<typeof InteractionOutcomeSchema>;

export const InteractionRequestBindingSchema = z.strictObject({
  runId: boundedIdentifierSchema,
  provider: boundedIdentifierSchema,
  environmentId: boundedIdentifierSchema,
  sessionId: boundedIdentifierSchema,
  executionId: boundedIdentifierSchema,
  interactionId: boundedIdentifierSchema,
});
export type InteractionRequestBinding = z.infer<
  typeof InteractionRequestBindingSchema
>;

/** Exact execution coordinates shared by every interaction from one provider turn. */
export const InteractionExecutionBindingSchema =
  InteractionRequestBindingSchema.omit({ interactionId: true });
export type InteractionExecutionBinding = z.infer<
  typeof InteractionExecutionBindingSchema
>;

/** Binding carried by a response command and acknowledgement. */
export const InteractionBindingSchema = z.strictObject({
  ...InteractionRequestBindingSchema.shape,
  requestDigest: sha256DigestSchema,
});
export type InteractionBinding = z.infer<typeof InteractionBindingSchema>;

export interface InteractionRequestMaterial {
  id: string;
  kind: string;
  title: string;
  body?: string;
  subject?: InteractionSubject;
  answerSpec: z.infer<typeof InteractionAnswerSpecSchema>;
  responseScopes?: z.infer<typeof InteractionResponseScopeSchema>[];
  allowedOutcomes?: InteractionOutcome[];
  default?: InteractionResolution;
  timeoutMs?: number;
  onTimeout?: "default" | "fail" | "wait";
  binding: InteractionRequestBinding;
}

export interface InteractionRequest extends InteractionRequestMaterial {
  requestDigest: Sha256Digest;
}

const InteractionRequestMaterialSchema = z.strictObject({
  id: boundedIdentifierSchema,
  kind: boundedIdentifierSchema,
  title: boundedStringSchema.min(1),
  body: boundedStringSchema.optional(),
  subject: InteractionSubjectSchema.optional(),
  answerSpec: InteractionAnswerSpecSchema,
  responseScopes: z
    .array(InteractionResponseScopeSchema)
    .min(1)
    .max(CONTRACT_MAX_ARRAY_LENGTH)
    .optional(),
  allowedOutcomes: z
    .array(InteractionOutcomeSchema)
    .min(1)
    .max(interactionOutcomeValues.length)
    .optional(),
  default: InteractionResolutionSchema.optional(),
  timeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  onTimeout: z.enum(["default", "fail", "wait"]).optional(),
  binding: InteractionRequestBindingSchema,
});

export function interactionRequestDigest(
  request: InteractionRequestMaterial,
): Sha256Digest {
  const parsed = InteractionRequestMaterialSchema.parse(request);
  rejectSecretDefaultValues(parsed);
  return canonicalCandidateDigest(parsed);
}

function rejectSecretDefaultValues(
  request: Pick<InteractionRequestMaterial, "answerSpec" | "default">,
): void {
  const secretFields = new Set(
    request.answerSpec.fields
      .filter((field) => field.type === "secret")
      .map((field) => field.name),
  );
  for (const fieldName of Object.keys(request.default?.data ?? {})) {
    if (secretFields.has(fieldName)) {
      throw new Error("secret answers cannot be embedded in interaction defaults");
    }
  }
}

// =============================================================================
// The request envelope.
// =============================================================================

export const InteractionRequestSchema = z
  .strictObject({
    ...InteractionRequestMaterialSchema.shape,
    requestDigest: sha256DigestSchema,
  })
  .superRefine((request, context) => {
    if (request.binding.interactionId !== request.id) {
      context.addIssue({
        code: "custom",
        path: ["binding", "interactionId"],
        message: "interaction binding must name the request id",
      });
    }
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
    if (
      request.allowedOutcomes &&
      new Set(request.allowedOutcomes).size !== request.allowedOutcomes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedOutcomes"],
        message: "interaction outcomes must be unique",
      });
    }
    if (request.onTimeout === "default" && request.default === undefined) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "onTimeout=default requires a default resolution",
      });
    }
    if (
      request.default &&
      request.allowedOutcomes &&
      !request.allowedOutcomes.includes(request.default.outcome)
    ) {
      context.addIssue({
        code: "custom",
        path: ["default", "outcome"],
        message: "default outcome is not allowed by the request",
      });
    }
    if (request.default) {
      for (const error of validateResolutionForRequest(request, request.default)) {
        context.addIssue({ code: "custom", path: ["default"], message: error });
      }
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
    const { requestDigest: _digest, ...material } = request;
    const hasSecretDefault = Object.keys(request.default?.data ?? {}).some(
      (fieldName) =>
        request.answerSpec.fields.some(
          (field) => field.type === "secret" && field.name === fieldName,
        ),
    );
    if (!hasSecretDefault) {
      if (request.requestDigest !== interactionRequestDigest(material)) {
        context.addIssue({
          code: "custom",
          path: ["requestDigest"],
          message: "interaction request digest does not match its content",
        });
      }
    }
  }) satisfies z.ZodType<InteractionRequest>;

export const InteractionResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    id: boundedIdentifierSchema,
    outcome: z.literal("accepted"),
    data: InteractionDataSchema.optional(),
  }),
  z.strictObject({
    id: boundedIdentifierSchema,
    outcome: z.literal("declined"),
    data: InteractionDataSchema.optional(),
  }),
  z.strictObject({
    id: boundedIdentifierSchema,
    outcome: z.literal("cancelled"),
    data: InteractionDataSchema.optional(),
  }),
]);
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

export interface InteractionResponseCommandMaterial {
  binding: InteractionBinding;
  response: InteractionResponse;
}

/** Digest the exact binding and response carried by a retryable command. */
export function interactionResponseCommandDigest(
  material: InteractionResponseCommandMaterial,
): Sha256Digest {
  const binding = InteractionBindingSchema.parse(material.binding);
  const response = InteractionResponseSchema.parse(material.response);
  return canonicalCandidateDigest({ binding, response });
}

/** Retryable command sent to an environment or retained session. */
export const InteractionResponseCommandSchema = z
  .strictObject({
    operationId: boundedIdentifierSchema,
    binding: InteractionBindingSchema,
    commandDigest: sha256DigestSchema,
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
    if (
      command.commandDigest !==
      interactionResponseCommandDigest({
        binding: command.binding,
        response: command.response,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["commandDigest"],
        message: "interaction response command digest does not match its content",
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
    operationId: boundedIdentifierSchema,
    binding: InteractionBindingSchema,
    commandDigest: sha256DigestSchema,
    status: InteractionAcknowledgementStatusSchema,
    message: boundedStringSchema.min(1).optional(),
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

void InteractionOutcomeSchema;
