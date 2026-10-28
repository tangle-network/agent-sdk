import { z } from "zod";
import { sha256DigestSchema } from "./agent-candidate-schema-common.js";
import { CONTRACT_MAX_ARRAY_LENGTH } from "./contract-limits.js";
import { InteractionBindingSchema, InteractionRequestSchema } from "./interaction-envelope.js";

/** Delivery is independent of recording a response; only delivered proves its native effect. */
export const InteractionResolutionDeliveryStateSchema = z.enum([
  "pending", "delivering", "delivered", "delivery_failed", "backend_lost", "effect_unknown",
]);
export type InteractionResolutionDeliveryState = z.infer<typeof InteractionResolutionDeliveryStateSchema>;

/** Durable resolution metadata, including legacy records without an exact binding. */
export const InteractionResolutionAcknowledgementSchema = z.strictObject({
  status: z.enum(["accepted", "already_resolved_same"]),
  operationId: z.string().min(1),
  responseDigest: sha256DigestSchema,
  interactionId: z.string().min(1),
  sessionId: z.string().min(1),
  outcome: z.enum(["accepted", "declined", "cancelled"]),
  deliveryState: InteractionResolutionDeliveryStateSchema,
  delivered: z.boolean(),
  resolvedAt: z.string().min(1),
  binding: InteractionBindingSchema.optional(),
});
export type InteractionResolutionAcknowledgement = z.infer<typeof InteractionResolutionAcknowledgementSchema>;

/** Owner truth at one read; an absent owner and an empty outstanding set are different facts. */
export const InteractionSnapshotSchema = z.strictObject({
  availability: z.enum(["available", "missing", "unavailable"]),
  sessionId: InteractionBindingSchema.shape.sessionId,
  executionId: InteractionBindingSchema.shape.executionId.optional(),
  interactions: z.array(InteractionRequestSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
  resolutions: z.array(InteractionResolutionAcknowledgementSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
});
export type InteractionSnapshot = z.infer<typeof InteractionSnapshotSchema>;

export interface InteractionReadOptions {
  state: true;
  executionId?: string;
  signal?: AbortSignal;
}

/** Optional owner-read capability; existing session implementations remain valid. */
export interface InteractionStateReader {
  interactions?(options: InteractionReadOptions): Promise<InteractionSnapshot>;
}
