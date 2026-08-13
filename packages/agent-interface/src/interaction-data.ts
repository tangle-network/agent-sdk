import { z } from "zod";
import {
  boundedIdentifierSchema,
  boundedStringSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_MAP_ENTRIES,
} from "./contract-limits.js";
import {
  InteractionFieldNameSchema,
  RESERVED_INTERACTION_FIELD_NAMES,
} from "./interaction-fields.js";

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
  .unknown()
  // A record parser assigns keys onto an ordinary object, so a raw own key
  // `__proto__` invokes the legacy prototype setter and vanishes before any
  // key schema runs. Reject reserved keys on the raw input, so this schema and
  // `validateInteractionResponse` refuse the same value rather than one of them
  // accepting a silently emptied object.
  .superRefine((value, refinement) => {
    if (value === null || typeof value !== "object") return;
    for (const key of Object.getOwnPropertyNames(value)) {
      if (RESERVED_INTERACTION_FIELD_NAMES.has(key)) {
        refinement.addIssue({
          code: "custom",
          message: `interaction field name "${key}" is reserved`,
        });
      }
    }
  })
  .pipe(
    z
      .record(InteractionFieldNameSchema, InteractionDataValueSchema)
      .superRefine((data, refinement) => {
        if (Object.keys(data).length > CONTRACT_MAX_MAP_ENTRIES) {
          refinement.addIssue({
            code: "custom",
            message: "interaction data has too many fields",
          });
        }
      }),
  )
  .transform((data) => {
    const safe: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(data)) safe[key] = data[key];
    return safe as Record<string, InteractionDataValue>;
  }) as z.ZodType<Record<string, InteractionDataValue>>;
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
