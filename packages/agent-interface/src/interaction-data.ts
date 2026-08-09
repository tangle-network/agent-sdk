import { z } from "zod";
import {
  boundedIdentifierSchema,
  boundedStringSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_MAP_ENTRIES,
} from "./contract-limits.js";
import { InteractionFieldNameSchema } from "./interaction-fields.js";

export const InteractionSecretReferenceSchema = z.strictObject({
  kind: z.literal("secret_handle"),
  handleId: boundedIdentifierSchema,
  oneUse: z.literal(true),
});
export type InteractionSecretReference = z.infer<
  typeof InteractionSecretReferenceSchema
>;

const InteractionDataValueSchema = z.union([
  boundedStringSchema,
  z.number().finite(),
  z.boolean(),
  z.array(boundedStringSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
  InteractionSecretReferenceSchema,
]);

export type InteractionDataValue =
  | string
  | number
  | boolean
  | string[]
  | InteractionSecretReference;

/** Field values keyed by InteractionField.name. */
export const InteractionDataSchema: z.ZodType<
  Record<string, InteractionDataValue>
> = z
  .record(InteractionFieldNameSchema, InteractionDataValueSchema)
  .superRefine((data, refinement) => {
    if (Object.keys(data).length > CONTRACT_MAX_MAP_ENTRIES) {
      refinement.addIssue({
        code: "custom",
        message: "interaction data has too many fields",
      });
    }
  })
  .transform((data) => {
    const safe: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(data)) safe[key] = data[key];
    return safe as Record<string, InteractionDataValue>;
  });
export type InteractionData = Record<string, InteractionDataValue>;

export const InteractionResolutionSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("accepted"),
    data: InteractionDataSchema.optional(),
  }),
  z.strictObject({
    outcome: z.literal("declined"),
    data: InteractionDataSchema.optional(),
  }),
  z.strictObject({
    outcome: z.literal("cancelled"),
    data: InteractionDataSchema.optional(),
  }),
]);
export type InteractionResolution = z.infer<typeof InteractionResolutionSchema>;
