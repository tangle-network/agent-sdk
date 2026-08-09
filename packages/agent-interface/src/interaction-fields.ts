import { z } from "zod";
import {
  boundedIdentifierSchema,
  boundedStringSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_STRING_LENGTH,
} from "./contract-limits.js";

const forbiddenFieldNames = new Set(["__proto__", "constructor", "prototype"]);
export const InteractionFieldNameSchema = boundedIdentifierSchema.refine(
  (value) => !forbiddenFieldNames.has(value),
  "interaction field name is reserved",
);

// =============================================================================
// Answer specification — describes the shape of a valid answer.
// =============================================================================

const FieldBase = {
  /** Stable key the answer is returned under in `InteractionResponse.data`. */
  name: InteractionFieldNameSchema,
  /** Human-readable label for the form control. */
  label: boundedStringSchema.min(1),
  /** Whether the answer must supply this field to be `accepted`. */
  required: z.boolean().optional(),
};

export const InteractionFieldSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...FieldBase,
      type: z.literal("text"),
      multiline: z.boolean().optional(),
      placeholder: boundedStringSchema.optional(),
      /** Maximum answer length chosen by the request author. */
      maxLength: z.number().int().positive().max(CONTRACT_MAX_STRING_LENGTH).optional(),
      default: boundedStringSchema.optional(),
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
            value: boundedIdentifierSchema,
            label: boundedStringSchema.min(1),
            description: boundedStringSchema.optional(),
          }),
        )
        .min(1)
        .max(CONTRACT_MAX_ARRAY_LENGTH),
      /** When true the user may pick more than one option. */
      multi: z.boolean().optional(),
      /**
       * When true the answer may contain write-in values outside `options`
       * (e.g. a rendered "Other…" choice carrying the user's own text).
       * Write-ins must still be non-empty strings.
       */
      allowCustom: z.boolean().optional(),
      default: z.array(boundedIdentifierSchema).max(CONTRACT_MAX_ARRAY_LENGTH).optional(),
    }),
    /** Like `text` but the value is sensitive (token/key) and must be masked. */
    z.strictObject({
      ...FieldBase,
      type: z.literal("secret"),
      placeholder: boundedStringSchema.optional(),
      /** Maximum answer length chosen by the request author. */
      maxLength: z.number().int().positive().max(CONTRACT_MAX_STRING_LENGTH).optional(),
    }),
  ])
  .superRefine((field, context) => {
    if (
      field.type === "text" &&
      field.default !== undefined &&
      field.maxLength !== undefined &&
      field.default.length > field.maxLength
    ) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "text field default exceeds maxLength",
      });
      return;
    }
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
    fields: z.array(InteractionFieldSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
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
    kinds: z.array(boundedIdentifierSchema).min(1).max(CONTRACT_MAX_ARRAY_LENGTH),
    answerFieldTypes: z.array(InteractionFieldTypeSchema).min(1).max(CONTRACT_MAX_ARRAY_LENGTH),
    responseScopes: z.array(InteractionResponseScopeSchema).min(1).max(CONTRACT_MAX_ARRAY_LENGTH),
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
