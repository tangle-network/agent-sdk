import { z } from "zod";
import type { StreamEvent } from "./stream-events.js";
import {
  canonicalCandidateDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  boundedIdentifierSchema,
  boundedJsonRecordSchema,
  boundedJsonSchema,
  boundedStringSchema,
} from "./contract-limits.js";
import { InteractionRequestSchema } from "./interaction.js";
import { DurablePlanSchema } from "./plan.js";

const stableIdSchema = boundedIdentifierSchema;

/** Provider-neutral coordinates sufficient to recreate control of one run. */
export interface AgentRunControlRef {
  runId: string;
  provider: string;
  environmentId: string;
  sessionId?: string;
  executionId?: string;
  /** Provider admission digest for detecting changed-input run reuse. */
  requestDigest?: Sha256Digest;
}

export const AgentRunControlRefSchema = z.strictObject({
  runId: stableIdSchema,
  provider: stableIdSchema,
  environmentId: stableIdSchema,
  sessionId: stableIdSchema.optional(),
  executionId: stableIdSchema.optional(),
  requestDigest: sha256DigestSchema.optional(),
}) satisfies z.ZodType<AgentRunControlRef>;

/** Coordinates that are complete enough for a retryable state-changing action. */
export interface AgentExactRunControlRef extends AgentRunControlRef {
  sessionId: string;
  executionId: string;
  requestDigest: Sha256Digest;
}

export const AgentExactRunControlRefSchema = AgentRunControlRefSchema.extend({
  sessionId: stableIdSchema,
  executionId: stableIdSchema,
  requestDigest: sha256DigestSchema,
}) satisfies z.ZodType<AgentExactRunControlRef>;

export type AgentRunCancellationEffect =
  | "cancel_requested"
  | "cancelled"
  | "not_live"
  | "unknown";

export interface AgentRunCancellationRequestMaterial {
  operationId: string;
  run: AgentExactRunControlRef;
  reason?: string;
}

export interface AgentRunCancellationRequest
  extends AgentRunCancellationRequestMaterial {
  requestDigest: Sha256Digest;
}

export function agentRunCancellationRequestDigest(
  request: AgentRunCancellationRequestMaterial,
): Sha256Digest {
  const parsed = AgentRunCancellationRequestMaterialSchema.parse(request);
  return canonicalCandidateDigest({
    operationId: parsed.operationId,
    run: parsed.run,
    ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
  });
}

const AgentRunCancellationRequestMaterialSchema = z.strictObject({
  operationId: stableIdSchema,
  run: AgentExactRunControlRefSchema,
  reason: boundedStringSchema.min(1).max(2_048).optional(),
});

export const AgentRunCancellationRequestSchema = z
  .strictObject({
    ...AgentRunCancellationRequestMaterialSchema.shape,
    requestDigest: sha256DigestSchema,
  })
  .superRefine((request, refinement) => {
    const { requestDigest: _requestDigest, ...material } = request;
    if (request.requestDigest !== agentRunCancellationRequestDigest(material)) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "run cancellation request digest does not match its content",
      });
    }
  }) satisfies z.ZodType<AgentRunCancellationRequest>;

export interface AgentRunCancellationAcknowledgement {
  operationId: string;
  requestDigest: Sha256Digest;
  run: AgentExactRunControlRef;
  status: "accepted" | "replayed" | "conflict" | "unknown";
  effect: AgentRunCancellationEffect;
  message?: string;
  retryable?: boolean;
  existingRequestDigest?: Sha256Digest;
}

export const AgentRunCancellationAcknowledgementSchema = z
  .strictObject({
    operationId: stableIdSchema,
    requestDigest: sha256DigestSchema,
    run: AgentExactRunControlRefSchema,
    status: z.enum(["accepted", "replayed", "conflict", "unknown"]),
    effect: z.enum(["cancel_requested", "cancelled", "not_live", "unknown"]),
    message: boundedStringSchema.min(1).optional(),
    retryable: z.boolean().optional(),
    existingRequestDigest: sha256DigestSchema.optional(),
  })
  .superRefine((acknowledgement, refinement) => {
    const known = acknowledgement.effect !== "unknown";
    if (
      ((acknowledgement.status === "accepted" ||
        acknowledgement.status === "replayed") &&
        !known) ||
      ((acknowledgement.status === "conflict" ||
        acknowledgement.status === "unknown") &&
        known)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["effect"],
        message: "cancellation status and effect certainty do not agree",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.existingRequestDigest === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a cancellation conflict must include the existing digest",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.existingRequestDigest === acknowledgement.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a cancellation conflict must identify a different request",
      });
    }
    if (
      acknowledgement.status !== "conflict" &&
      acknowledgement.existingRequestDigest !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "only a cancellation conflict may include an existing digest",
      });
    }
    if (
      acknowledgement.status === "unknown" &&
      (acknowledgement.message === undefined || acknowledgement.retryable !== false)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "an unknown cancellation outcome must be explicit and non-repeatable",
      });
    }
  }) satisfies z.ZodType<AgentRunCancellationAcknowledgement>;

export function agentRunCancellationAcknowledgementMatchesRequest(
  request: AgentRunCancellationRequest,
  acknowledgement: AgentRunCancellationAcknowledgement,
): boolean {
  const exactRequest = AgentRunCancellationRequestSchema.safeParse(request);
  const exactAcknowledgement =
    AgentRunCancellationAcknowledgementSchema.safeParse(acknowledgement);
  if (!exactRequest.success || !exactAcknowledgement.success) return false;
  return (
    exactAcknowledgement.data.operationId === exactRequest.data.operationId &&
    exactAcknowledgement.data.requestDigest === exactRequest.data.requestDigest &&
    canonicalCandidateDigest(exactAcknowledgement.data.run) ===
      canonicalCandidateDigest(exactRequest.data.run)
  );
}

export type AgentRunControlAction = "steer" | "cancel" | "status" | "reconnect";

export interface AgentRunControlRequestMaterial {
  operationId: string;
  action: AgentRunControlAction;
  run: AgentExactRunControlRef;
  payload?: Record<string, unknown>;
}

export interface AgentRunControlRequest extends AgentRunControlRequestMaterial {
  requestDigest: Sha256Digest;
}

export function agentRunControlRequestDigest(
  request: AgentRunControlRequestMaterial,
): Sha256Digest {
  const parsed = AgentRunControlRequestMaterialSchema.parse(request);
  return canonicalCandidateDigest({
    operationId: parsed.operationId,
    action: parsed.action,
    run: parsed.run,
    ...(parsed.payload === undefined ? {} : { payload: parsed.payload }),
  });
}

const AgentRunControlRequestMaterialSchema = z.strictObject({
  operationId: stableIdSchema,
  action: z.enum(["steer", "cancel", "status", "reconnect"]),
  run: AgentExactRunControlRefSchema,
  payload: boundedJsonRecordSchema.optional(),
});

export const AgentRunControlRequestSchema = z
  .strictObject({
    ...AgentRunControlRequestMaterialSchema.shape,
    requestDigest: sha256DigestSchema,
  })
  .superRefine((request, refinement) => {
    const { requestDigest: _requestDigest, ...material } = request;
    if (request.requestDigest !== agentRunControlRequestDigest(material)) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "run control request digest does not match its content",
      });
    }
  }) satisfies z.ZodType<AgentRunControlRequest>;

export interface AgentRunControlAcknowledgement {
  operationId: string;
  requestDigest: Sha256Digest;
  run: AgentExactRunControlRef;
  status: "accepted" | "replayed" | "conflict" | "unknown";
  message?: string;
  retryable?: boolean;
  existingRequestDigest?: Sha256Digest;
}

export const AgentRunControlAcknowledgementSchema = z
  .strictObject({
    operationId: stableIdSchema,
    requestDigest: sha256DigestSchema,
    run: AgentExactRunControlRefSchema,
    status: z.enum(["accepted", "replayed", "conflict", "unknown"]),
    message: boundedStringSchema.min(1).optional(),
    retryable: z.boolean().optional(),
    existingRequestDigest: sha256DigestSchema.optional(),
  })
  .superRefine((acknowledgement, refinement) => {
    if (
      acknowledgement.status === "conflict" &&
      (acknowledgement.existingRequestDigest === undefined ||
        acknowledgement.existingRequestDigest === acknowledgement.requestDigest)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a control conflict must identify a different existing request",
      });
    }
    if (
      acknowledgement.status !== "conflict" &&
      acknowledgement.existingRequestDigest !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "only a control conflict may include an existing digest",
      });
    }
    if (
      acknowledgement.status === "unknown" &&
      (acknowledgement.message === undefined || acknowledgement.retryable !== false)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "an unknown control outcome must be explicit and non-repeatable",
      });
    }
  }) satisfies z.ZodType<AgentRunControlAcknowledgement>;

export function agentRunControlAcknowledgementMatchesRequest(
  request: AgentRunControlRequest,
  acknowledgement: AgentRunControlAcknowledgement,
): boolean {
  const exactRequest = AgentRunControlRequestSchema.safeParse(request);
  const exactAcknowledgement = AgentRunControlAcknowledgementSchema.safeParse(
    acknowledgement,
  );
  if (!exactRequest.success || !exactAcknowledgement.success) return false;
  return (
    exactAcknowledgement.data.operationId === exactRequest.data.operationId &&
    exactAcknowledgement.data.requestDigest === exactRequest.data.requestDigest &&
    canonicalCandidateDigest(exactAcknowledgement.data.run) ===
      canonicalCandidateDigest(exactRequest.data.run)
  );
}

const unknownRecordSchema = boundedJsonRecordSchema;
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
    raw: boundedStringSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("running"),
    input: unknownRecordSchema,
    title: boundedStringSchema.optional(),
    metadata: unknownRecordSchema.optional(),
    time: z.strictObject({ start: z.number().finite() }).optional(),
  }),
  z.strictObject({
    status: z.literal("completed"),
    input: unknownRecordSchema,
    output: boundedJsonSchema,
    title: boundedStringSchema.optional(),
    metadata: unknownRecordSchema.optional(),
    time: z.strictObject({
      start: z.number().finite(),
      end: z.number().finite(),
    }).optional(),
  }),
  z.strictObject({
    status: z.enum(["error", "failed"]),
    input: unknownRecordSchema,
    error: boundedStringSchema.optional(),
    output: boundedJsonSchema.optional(),
    metadata: unknownRecordSchema.optional(),
    time: toolTimeSchema.optional(),
  }),
]);
const partSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...partBase, type: z.literal("text"), text: boundedStringSchema }),
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
    text: boundedStringSchema,
  }),
  z.strictObject({
    ...partBase,
    type: z.literal("file"),
    filename: boundedStringSchema.optional(),
    mediaType: boundedStringSchema.optional(),
    url: boundedStringSchema.optional(),
  }),
  z.strictObject({
    ...partBase,
    type: z.literal("subtask"),
    prompt: boundedStringSchema,
    description: boundedStringSchema,
    agent: stableIdSchema,
  }),
]);

/** Runtime validator for every member of the existing canonical event union. */
export const CanonicalStreamEventSchema: z.ZodType<StreamEvent> =
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("message.part.updated"),
      part: partSchema,
      delta: boundedStringSchema.optional(),
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
      detail: boundedStringSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("warning"),
      code: stableIdSchema,
      message: boundedStringSchema,
    }),
    z.strictObject({
      type: z.literal("raw"),
      backend: stableIdSchema,
      event: boundedJsonSchema,
    }),
    z.strictObject({
      type: z.literal("session.updated"),
      sessionId: stableIdSchema,
      title: boundedStringSchema.optional(),
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
      reason: boundedStringSchema.optional(),
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
  occurredAt: z.iso.datetime().max(64).optional(),
  receivedAt: z.iso.datetime().max(64),
  event: CanonicalStreamEventSchema,
}) satisfies z.ZodType<RuntimeEventEnvelope>;
