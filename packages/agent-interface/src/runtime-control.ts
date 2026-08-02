import { z } from "zod";
import type { StreamEvent } from "./index.js";
import { InteractionRequestSchema } from "./interaction.js";
import { DurablePlanSchema } from "./plan.js";

const stableIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, "identifier cannot have outer whitespace");

/** Provider-neutral coordinates sufficient to recreate control of one run. */
export interface AgentRunControlRef {
  runId: string;
  provider: string;
  environmentId: string;
  sessionId?: string;
  executionId?: string;
}

export const AgentRunControlRefSchema = z.strictObject({
  runId: stableIdSchema,
  provider: stableIdSchema,
  environmentId: stableIdSchema,
  sessionId: stableIdSchema.optional(),
  executionId: stableIdSchema.optional(),
}) satisfies z.ZodType<AgentRunControlRef>;

const unknownRecordSchema = z.record(z.string(), z.unknown());
const partBase = {
  id: stableIdSchema,
  sessionID: stableIdSchema,
  messageID: stableIdSchema,
};
const toolTimeSchema = z.strictObject({
  start: z.number().finite(),
  end: z.number().finite().optional(),
});
const toolStateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    input: unknownRecordSchema,
    raw: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("running"),
    input: unknownRecordSchema,
    title: z.string().optional(),
    metadata: unknownRecordSchema.optional(),
    time: z.strictObject({ start: z.number().finite() }).optional(),
  }),
  z.strictObject({
    status: z.literal("completed"),
    input: unknownRecordSchema,
    output: z.unknown(),
    title: z.string().optional(),
    metadata: unknownRecordSchema.optional(),
    time: z.strictObject({
      start: z.number().finite(),
      end: z.number().finite(),
    }).optional(),
  }),
  z.strictObject({
    status: z.enum(["error", "failed"]),
    input: unknownRecordSchema,
    error: z.string().optional(),
    output: z.unknown().optional(),
    metadata: unknownRecordSchema.optional(),
    time: toolTimeSchema.optional(),
  }),
]);
const partSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...partBase, type: z.literal("text"), text: z.string() }),
  z.strictObject({
    ...partBase,
    type: z.literal("tool"),
    callID: stableIdSchema.optional(),
    tool: stableIdSchema,
    state: toolStateSchema,
    metadata: unknownRecordSchema.optional(),
  }),
  z.strictObject({
    ...partBase,
    type: z.literal("reasoning"),
    text: z.string(),
  }),
  z.strictObject({
    ...partBase,
    type: z.literal("file"),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
    url: z.string().optional(),
  }),
  z.strictObject({
    ...partBase,
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: stableIdSchema,
  }),
]);

/** Runtime validator for every member of the existing canonical event union. */
export const CanonicalStreamEventSchema: z.ZodType<StreamEvent> =
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("message.part.updated"),
      part: partSchema,
      delta: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("tool-heartbeat"),
      toolName: stableIdSchema,
      partId: stableIdSchema,
      elapsedMs: z.number().finite().nonnegative(),
    }),
    z.strictObject({
      type: z.literal("tool-slow"),
      toolName: stableIdSchema,
      partId: stableIdSchema,
      elapsedMs: z.number().finite().nonnegative(),
      thresholdMs: z.number().finite().nonnegative(),
    }),
    z.strictObject({
      type: z.literal("model-processing"),
      phase: z.enum(["tool-result", "generating", "thinking"]),
      toolName: stableIdSchema.optional(),
      elapsedMs: z.number().finite().nonnegative().optional(),
    }),
    z.strictObject({
      type: z.literal("status"),
      status: z.enum(["started", "processing", "completed", "failed"]),
      detail: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("warning"),
      code: stableIdSchema,
      message: z.string(),
    }),
    z.strictObject({
      type: z.literal("raw"),
      backend: stableIdSchema,
      event: z.unknown(),
    }),
    z.strictObject({
      type: z.literal("session.updated"),
      sessionId: stableIdSchema,
      title: z.string().optional(),
      time: z.strictObject({
        created: z.number().finite().optional(),
        updated: z.number().finite().optional(),
      }).optional(),
    }),
    z.strictObject({
      type: z.literal("interaction"),
      request: InteractionRequestSchema,
    }),
    z.strictObject({
      type: z.literal("interaction.cancel"),
      id: stableIdSchema,
      reason: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("plan.submitted"),
      plan: DurablePlanSchema,
    }),
  ]);

/** Ordered, replayable envelope around the existing canonical event union. */
export interface RuntimeEventEnvelope {
  runId: string;
  eventId: string;
  sequence: number;
  cursor?: string;
  occurredAt?: string;
  receivedAt: string;
  event: StreamEvent;
}

export const RuntimeEventEnvelopeSchema = z.strictObject({
  runId: stableIdSchema,
  eventId: stableIdSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cursor: stableIdSchema.optional(),
  occurredAt: z.iso.datetime().optional(),
  receivedAt: z.iso.datetime(),
  event: CanonicalStreamEventSchema,
}) satisfies z.ZodType<RuntimeEventEnvelope>;
