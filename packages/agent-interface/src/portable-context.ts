import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  canonicalCandidateDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import type { BackendMessage, InputPart } from "./index.js";
import {
  AgentRunControlRefSchema,
  type AgentRunControlRef,
} from "./runtime-control.js";

const idSchema = z.string().min(1).max(512);
const jsonRecordSchema = z.record(z.string(), z.json());

function wireDigest(value: unknown): Sha256Digest {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("portable context material must be JSON serializable");
  }
  return canonicalCandidateDigest(JSON.parse(serialized) as unknown);
}

const InputPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("file"),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
    content: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("image"),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
  }),
]) satisfies z.ZodType<InputPart>;

const BackendMessageSchema = z.strictObject({
  id: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(z.json()),
  timestamp: z.iso.datetime(),
  metadata: jsonRecordSchema.optional(),
}) satisfies z.ZodType<BackendMessage>;

export interface PortableContextSourceBoundary {
  runId: string;
  messageId?: string;
  provider?: string;
  environmentId?: string;
  sessionId?: string;
}

export const PortableContextSourceBoundarySchema = z.strictObject({
  runId: idSchema,
  messageId: idSchema.optional(),
  provider: idSchema.optional(),
  environmentId: idSchema.optional(),
  sessionId: idSchema.optional(),
}) satisfies z.ZodType<PortableContextSourceBoundary>;

export interface PortableContextAttachmentRef {
  messageId: string;
  partIndex: number;
  digest: Sha256Digest;
  name?: string;
  mediaType?: string;
}

export const PortableContextAttachmentRefSchema = z.strictObject({
  messageId: idSchema,
  partIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  digest: sha256DigestSchema,
  name: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
}) satisfies z.ZodType<PortableContextAttachmentRef>;

export interface PortableConversationContext {
  source: PortableContextSourceBoundary;
  completeness: "complete" | "partial";
  messages: BackendMessage[];
  attachments: PortableContextAttachmentRef[];
  digest: Sha256Digest;
}

type PortableConversationContextMaterial = Omit<
  PortableConversationContext,
  "digest"
>;

export function portableConversationContextDigest(
  context: PortableConversationContextMaterial,
): Sha256Digest {
  return wireDigest(context);
}

export const PortableConversationContextSchema = z
  .strictObject({
    source: PortableContextSourceBoundarySchema,
    completeness: z.enum(["complete", "partial"]),
    messages: z.array(BackendMessageSchema),
    attachments: z.array(PortableContextAttachmentRefSchema),
    digest: sha256DigestSchema,
  })
  .superRefine((context, refinement) => {
    const messageIds = context.messages.map((message) => message.id);
    if (new Set(messageIds).size !== messageIds.length) {
      refinement.addIssue({
        code: "custom",
        path: ["messages"],
        message: "portable context message ids must be unique",
      });
    }
    for (const attachment of context.attachments) {
      const message = context.messages.find(
        (candidate) => candidate.id === attachment.messageId,
      );
      if (!message || attachment.partIndex >= message.parts.length) {
        refinement.addIssue({
          code: "custom",
          path: ["attachments"],
          message: "attachment must reference a part in the portable context",
        });
      }
    }
    if (
      context.digest !==
      portableConversationContextDigest({
        source: context.source,
        completeness: context.completeness,
        messages: context.messages,
        attachments: context.attachments,
      })
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["digest"],
        message: "portable context digest does not match its content",
      });
    }
  }) satisfies z.ZodType<PortableConversationContext>;

export interface PortableContextDestination {
  runner: string;
  provider?: string;
  model?: string;
  profileDigest?: Sha256Digest;
}

export const PortableContextDestinationSchema = z.strictObject({
  runner: idSchema,
  provider: idSchema.optional(),
  model: idSchema.optional(),
  profileDigest: sha256DigestSchema.optional(),
}) satisfies z.ZodType<PortableContextDestination>;

export interface PortableContextPartPlan {
  partIndex: number;
  action: "include" | "transform" | "omit";
  output?: InputPart;
  reason?: string;
}

export const PortableContextPartPlanSchema = z
  .strictObject({
    partIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    action: z.enum(["include", "transform", "omit"]),
    output: InputPartSchema.optional(),
    reason: z.string().min(1).optional(),
  })
  .superRefine((part, refinement) => {
    if (part.action === "transform" && part.output === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["output"],
        message: "a transformed part must include its portable output",
      });
    }
    if (part.action !== "transform" && part.output !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["output"],
        message: "only a transformed part may include portable output",
      });
    }
    if (part.action !== "include" && part.reason === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["reason"],
        message: "a transformed or omitted part must include a reason",
      });
    }
  }) satisfies z.ZodType<PortableContextPartPlan>;

export interface PortableContextMessagePlan {
  messageId: string;
  action: "include" | "omit";
  parts: PortableContextPartPlan[];
  reason?: string;
}

export const PortableContextMessagePlanSchema = z
  .strictObject({
    messageId: idSchema,
    action: z.enum(["include", "omit"]),
    parts: z.array(PortableContextPartPlanSchema),
    reason: z.string().min(1).optional(),
  })
  .superRefine((message, refinement) => {
    const indexes = message.parts.map((part) => part.partIndex);
    if (new Set(indexes).size !== indexes.length) {
      refinement.addIssue({
        code: "custom",
        path: ["parts"],
        message: "part indexes must be unique within a message plan",
      });
    }
    if (message.action === "omit") {
      if (message.reason === undefined) {
        refinement.addIssue({
          code: "custom",
          path: ["reason"],
          message: "an omitted message must include a reason",
        });
      }
      if (message.parts.some((part) => part.action !== "omit")) {
        refinement.addIssue({
          code: "custom",
          path: ["parts"],
          message: "every part of an omitted message must be omitted",
        });
      }
    }
  }) satisfies z.ZodType<PortableContextMessagePlan>;

export interface PortableContextPlan {
  planId: string;
  /** Full immutable source so an executor can verify every decision itself. */
  source: PortableConversationContext;
  destination: PortableContextDestination;
  messages: PortableContextMessagePlan[];
  context: PortableConversationContext;
  estimatedTokens?: number;
  requiresAcceptance: boolean;
  digest: Sha256Digest;
}

export type PortableContextPlanMaterial = Omit<PortableContextPlan, "digest">;

export function portableContextPlanDigest(
  plan: PortableContextPlanMaterial,
): Sha256Digest {
  return wireDigest(plan);
}

export const PortableContextPlanSchema = z
  .strictObject({
    planId: idSchema,
    source: PortableConversationContextSchema,
    destination: PortableContextDestinationSchema,
    messages: z.array(PortableContextMessagePlanSchema),
    context: PortableConversationContextSchema,
    estimatedTokens: z.number().int().nonnegative().optional(),
    requiresAcceptance: z.boolean(),
    digest: sha256DigestSchema,
  })
  .superRefine((plan, refinement) => {
    const messageIds = plan.messages.map((message) => message.messageId);
    if (new Set(messageIds).size !== messageIds.length) {
      refinement.addIssue({
        code: "custom",
        path: ["messages"],
        message: "message ids must be unique within a context plan",
      });
    }
    const sourceMessageIds = plan.source.messages.map((message) => message.id);
    if (!sameStringSet(messageIds, sourceMessageIds)) {
      refinement.addIssue({
        code: "custom",
        path: ["messages"],
        message: "a context plan must decide every source message exactly once",
      });
    }
    if (wireDigest(plan.context.source) !== wireDigest(plan.source.source)) {
      refinement.addIssue({
        code: "custom",
        path: ["context", "source"],
        message: "output context source must match the immutable source",
      });
    }

    const expectedMessages: BackendMessage[] = [];
    for (const sourceMessage of plan.source.messages) {
      const messagePlan = plan.messages.find(
        (candidate) => candidate.messageId === sourceMessage.id,
      );
      if (!messagePlan) continue;
      const expectedIndexes = sourceMessage.parts.map((_, index) => index);
      const decidedIndexes = messagePlan.parts
        .map((part) => part.partIndex)
        .sort((left, right) => left - right);
      if (JSON.stringify(expectedIndexes) !== JSON.stringify(decidedIndexes)) {
        refinement.addIssue({
          code: "custom",
          path: ["messages"],
          message: `message "${sourceMessage.id}" must decide every source part exactly once`,
        });
        continue;
      }
      if (messagePlan.action === "omit") continue;

      const outputParts: InputPart[] = [];
      for (const partPlan of [...messagePlan.parts].sort(
        (left, right) => left.partIndex - right.partIndex,
      )) {
        if (partPlan.action === "omit") continue;
        if (partPlan.action === "transform") {
          if (partPlan.output) outputParts.push(partPlan.output);
          continue;
        }
        const parsedPart = InputPartSchema.safeParse(
          sourceMessage.parts[partPlan.partIndex],
        );
        if (!parsedPart.success) {
          refinement.addIssue({
            code: "custom",
            path: ["messages"],
            message: `message "${sourceMessage.id}" part ${partPlan.partIndex} must be transformed or omitted`,
          });
          continue;
        }
        outputParts.push(parsedPart.data);
      }
      if (outputParts.length === 0) {
        refinement.addIssue({
          code: "custom",
          path: ["messages"],
          message: `included message "${sourceMessage.id}" must retain at least one part`,
        });
      }
      expectedMessages.push({ ...sourceMessage, parts: outputParts });
    }
    if (wireDigest(expectedMessages) !== wireDigest(plan.context.messages)) {
      refinement.addIssue({
        code: "custom",
        path: ["context", "messages"],
        message: "output messages do not exactly match the source decisions",
      });
    }

    const expectedAttachments = plan.source.attachments.filter((attachment) => {
      const message = plan.messages.find(
        (candidate) => candidate.messageId === attachment.messageId,
      );
      const part = message?.parts.find(
        (candidate) => candidate.partIndex === attachment.partIndex,
      );
      return message?.action === "include" && part?.action === "include";
    });
    if (wireDigest(expectedAttachments) !== wireDigest(plan.context.attachments)) {
      refinement.addIssue({
        code: "custom",
        path: ["context", "attachments"],
        message: "output attachments do not exactly match included source parts",
      });
    }
    const changesContent = plan.messages.some(
      (message) =>
        message.action === "omit" ||
        message.parts.some((part) => part.action !== "include"),
    );
    const requiresAcceptance =
      changesContent ||
      plan.source.completeness === "partial" ||
      plan.context.completeness === "partial";
    if (plan.requiresAcceptance !== requiresAcceptance) {
      refinement.addIssue({
        code: "custom",
        path: ["requiresAcceptance"],
        message:
          "requiresAcceptance must be true when content changes or either context is partial",
      });
    }
    const expectedCompleteness =
      changesContent || plan.source.completeness === "partial"
        ? "partial"
        : "complete";
    if (plan.context.completeness !== expectedCompleteness) {
      refinement.addIssue({
        code: "custom",
        path: ["context", "completeness"],
        message: `output context completeness must be ${expectedCompleteness}`,
      });
    }
    if (
      plan.digest !==
      portableContextPlanDigest({
        planId: plan.planId,
        source: plan.source,
        destination: plan.destination,
        messages: plan.messages,
        context: plan.context,
        estimatedTokens: plan.estimatedTokens,
        requiresAcceptance: plan.requiresAcceptance,
      })
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["digest"],
        message: "portable context plan digest does not match its content",
      });
    }
  }) satisfies z.ZodType<PortableContextPlan>;

export interface PortableContextPlanRequestMaterial {
  source: PortableConversationContext;
  destination: PortableContextDestination;
  maxInputTokens?: number;
}

export function portableContextPlanRequestDigest(
  request: PortableContextPlanRequestMaterial,
): Sha256Digest {
  return wireDigest(request);
}

export interface PortableContextPlanRequest
  extends PortableContextPlanRequestMaterial {
  requestId: string;
  requestDigest: Sha256Digest;
}

export const PortableContextPlanRequestSchema = z
  .strictObject({
    requestId: idSchema,
    requestDigest: sha256DigestSchema,
    source: PortableConversationContextSchema,
    destination: PortableContextDestinationSchema,
    maxInputTokens: z.number().int().positive().optional(),
  })
  .superRefine((request, refinement) => {
    if (
      request.requestDigest !==
      portableContextPlanRequestDigest({
        source: request.source,
        destination: request.destination,
        maxInputTokens: request.maxInputTokens,
      })
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "portable context plan request digest does not match its content",
      });
    }
  }) satisfies z.ZodType<PortableContextPlanRequest>;

interface PortableContextPlanResultBinding {
  requestId: string;
  requestDigest: Sha256Digest;
}

export type PortableContextPlanResult =
  | (PortableContextPlanResultBinding & {
      status: "ready";
      plan: PortableContextPlan;
    })
  | (PortableContextPlanResultBinding & {
      status: "over_limit";
      estimatedTokens?: number;
      maxInputTokens: number;
      suggestedBoundaryMessageId?: string;
      message: string;
    })
  | (PortableContextPlanResultBinding & {
      status: "unsupported";
      message: string;
    });

const portableContextPlanResultBinding = {
  requestId: idSchema,
  requestDigest: sha256DigestSchema,
};

export const PortableContextPlanResultSchema: z.ZodType<PortableContextPlanResult> =
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("ready"),
      ...portableContextPlanResultBinding,
      plan: PortableContextPlanSchema,
    }),
    z.strictObject({
      status: z.literal("over_limit"),
      ...portableContextPlanResultBinding,
      estimatedTokens: z.number().int().nonnegative().optional(),
      maxInputTokens: z.number().int().positive(),
      suggestedBoundaryMessageId: idSchema.optional(),
      message: z.string().min(1),
    }),
    z.strictObject({
      status: z.literal("unsupported"),
      ...portableContextPlanResultBinding,
      message: z.string().min(1),
    }),
  ]);

/** Cross-check a planner result against the exact request and token budget. */
export function portableContextPlanResultMatchesRequest(
  request: PortableContextPlanRequest,
  result: PortableContextPlanResult,
): boolean {
  const parsedRequest = PortableContextPlanRequestSchema.safeParse(request);
  const parsedResult = PortableContextPlanResultSchema.safeParse(result);
  if (!parsedRequest.success || !parsedResult.success) return false;

  const exactRequest = parsedRequest.data;
  const exactResult = parsedResult.data;
  if (
    exactResult.requestId !== exactRequest.requestId ||
    exactResult.requestDigest !== exactRequest.requestDigest
  ) {
    return false;
  }
  if (exactResult.status === "ready") {
    if (
      wireDigest(exactResult.plan.source) !== wireDigest(exactRequest.source) ||
      wireDigest(exactResult.plan.destination) !==
        wireDigest(exactRequest.destination)
    ) {
      return false;
    }
    if (exactRequest.maxInputTokens === undefined) return true;
    return (
      exactResult.plan.estimatedTokens !== undefined &&
      exactResult.plan.estimatedTokens <= exactRequest.maxInputTokens
    );
  }

  if (exactResult.status === "over_limit") {
    return (
      exactRequest.maxInputTokens !== undefined &&
      exactResult.maxInputTokens === exactRequest.maxInputTokens &&
      (exactResult.estimatedTokens === undefined ||
        exactResult.estimatedTokens > exactRequest.maxInputTokens) &&
      (exactResult.suggestedBoundaryMessageId === undefined ||
        exactRequest.source.messages.some(
          (message) =>
            message.id === exactResult.suggestedBoundaryMessageId,
        ))
    );
  }

  return true;
}

export const ContextPlanAcceptanceSchema = z.strictObject({
  planDigest: sha256DigestSchema,
  acceptedAt: z.iso.datetime(),
  acceptedBy: z.enum(["user", "policy", "system"]),
});
export type ContextPlanAcceptance = z.infer<
  typeof ContextPlanAcceptanceSchema
>;

export interface ContextTransferRequestMaterial {
  plan: PortableContextPlan;
  acceptance: ContextPlanAcceptance;
}

export function contextTransferRequestDigest(
  request: ContextTransferRequestMaterial,
): Sha256Digest {
  return wireDigest({
    planDigest: request.plan.digest,
    acceptance: request.acceptance,
  });
}

export const ContextTransferRequestSchema = z
  .strictObject({
    operationId: idSchema,
    requestDigest: sha256DigestSchema,
    plan: PortableContextPlanSchema,
    acceptance: ContextPlanAcceptanceSchema,
  })
  .superRefine((request, refinement) => {
    if (request.acceptance.planDigest !== request.plan.digest) {
      refinement.addIssue({
        code: "custom",
        path: ["acceptance", "planDigest"],
        message: "accepted plan digest must match the executed plan",
      });
    }
    if (request.requestDigest !== contextTransferRequestDigest(request)) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "context transfer request digest does not match its content",
      });
    }
    if (
      request.plan.requiresAcceptance &&
      request.acceptance.acceptedBy === "system"
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["acceptance", "acceptedBy"],
        message: "a transformed or partial plan requires user or policy acceptance",
      });
    }
  });
export type ContextTransferRequest = z.infer<typeof ContextTransferRequestSchema>;

function contextTransferReceiptVariant(status: "accepted" | "replayed") {
  return z
    .strictObject({
      status: z.literal(status),
      operationId: idSchema,
      requestDigest: sha256DigestSchema,
      planDigest: sha256DigestSchema,
      contextDigest: sha256DigestSchema,
      destination: PortableContextDestinationSchema,
      provider: idSchema,
      environmentId: idSchema,
      sessionId: idSchema,
      /** Provider assertion that this session was created for this transfer. */
      sessionCreatedForOperationId: idSchema,
      sessionCreatedAt: z.iso.datetime(),
      transferredMessageIds: z.array(idSchema),
      omittedMessageIds: z.array(idSchema),
      admittedAt: z.iso.datetime(),
    })
    .superRefine((receipt, refinement) => {
      const transferred = new Set(receipt.transferredMessageIds);
      const omitted = new Set(receipt.omittedMessageIds);
      if (transferred.size !== receipt.transferredMessageIds.length) {
        refinement.addIssue({
          code: "custom",
          path: ["transferredMessageIds"],
          message: "transferred message ids must be unique",
        });
      }
      if (omitted.size !== receipt.omittedMessageIds.length) {
        refinement.addIssue({
          code: "custom",
          path: ["omittedMessageIds"],
          message: "omitted message ids must be unique",
        });
      }
      if ([...transferred].some((messageId) => omitted.has(messageId))) {
        refinement.addIssue({
          code: "custom",
          path: ["omittedMessageIds"],
          message: "a message cannot be both transferred and omitted",
        });
      }
      if (Date.parse(receipt.sessionCreatedAt) > Date.parse(receipt.admittedAt)) {
        refinement.addIssue({
          code: "custom",
          path: ["sessionCreatedAt"],
          message: "the destination session must exist before context admission",
        });
      }
    });
}

export const ContextTransferReceiptSchema = z.discriminatedUnion("status", [
  contextTransferReceiptVariant("accepted"),
  contextTransferReceiptVariant("replayed"),
]);
export type ContextTransferReceipt = z.infer<
  typeof ContextTransferReceiptSchema
>;

export const ContextTransferResultSchema = z.discriminatedUnion("status", [
  contextTransferReceiptVariant("accepted"),
  contextTransferReceiptVariant("replayed"),
  z.strictObject({
    status: z.literal("conflict"),
    operationId: idSchema,
    requestDigest: sha256DigestSchema,
    existingRequestDigest: sha256DigestSchema,
  }),
  z.strictObject({
    status: z.enum(["unknown", "transport_failure"]),
    operationId: idSchema,
    requestDigest: sha256DigestSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]).superRefine((result, refinement) => {
  if (
    result.status === "conflict" &&
    result.existingRequestDigest === result.requestDigest
  ) {
    refinement.addIssue({
      code: "custom",
      path: ["existingRequestDigest"],
      message: "a transfer conflict must identify a different request",
    });
  }
});
export type ContextTransferResult = z.infer<
  typeof ContextTransferResultSchema
>;

/** Bind every transfer outcome to the exact operation before acting on it. */
export function contextTransferResultMatchesRequest(
  request: ContextTransferRequest,
  result: ContextTransferResult,
): boolean {
  const parsedRequest = ContextTransferRequestSchema.safeParse(request);
  const parsedResult = ContextTransferResultSchema.safeParse(result);
  if (!parsedRequest.success || !parsedResult.success) return false;

  const exactRequest = parsedRequest.data;
  const exactResult = parsedResult.data;
  if (
    exactResult.operationId !== exactRequest.operationId ||
    exactResult.requestDigest !== exactRequest.requestDigest
  ) {
    return false;
  }
  if (
    exactResult.status === "accepted" ||
    exactResult.status === "replayed"
  ) {
    return contextTransferReceiptMatches(exactRequest, exactResult);
  }
  return true;
}

export const NativeContextBoundarySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("token"), token: idSchema }),
    z.strictObject({ kind: z.literal("revision"), revision: idSchema }),
    z.strictObject({ kind: z.literal("digest"), digest: sha256DigestSchema }),
    z.strictObject({
      kind: z.literal("messages"),
      messageIds: z.array(idSchema),
      digest: sha256DigestSchema,
    }),
  ])
  .superRefine((boundary, refinement) => {
    if (
      boundary.kind === "messages" &&
      new Set(boundary.messageIds).size !== boundary.messageIds.length
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["messageIds"],
        message: "native context boundary message ids must be unique",
      });
    }
  });
export type NativeContextBoundary = z.infer<typeof NativeContextBoundarySchema>;

export const NativeContextBoundaryProofSchema = z.strictObject({
  runId: idSchema,
  provider: idSchema,
  environmentId: idSchema,
  sessionId: idSchema,
  boundary: NativeContextBoundarySchema,
  observedAt: z.iso.datetime(),
});
export type NativeContextBoundaryProof = z.infer<
  typeof NativeContextBoundaryProofSchema
>;

export interface NativeContextContinuationRequest {
  operationId: string;
  requestDigest: Sha256Digest;
  turnDigest: Sha256Digest;
  run: AgentRunControlRef;
  expectedBoundary: NativeContextBoundaryProof;
}

export interface NativeContextContinuationRequestMaterial {
  turnDigest: Sha256Digest;
  run: AgentRunControlRef;
  expectedBoundary: NativeContextBoundaryProof;
}

/** JSON-stable user turn admitted by a native same-session continuation. */
export interface NativeContextContinuationTurn {
  prompt?: string;
  parts?: InputPart[];
  model?: string;
  context?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

export const NativeContextContinuationTurnSchema = z.strictObject({
  prompt: z.string().optional(),
  parts: z.array(InputPartSchema).optional(),
  model: z.string().min(1).optional(),
  context: jsonRecordSchema.optional(),
  providerOptions: jsonRecordSchema.optional(),
}) satisfies z.ZodType<NativeContextContinuationTurn>;

/** Bind retry identity to the exact new user turn, excluding timeout and abort controls. */
export function nativeContextContinuationTurnDigest(
  turn: NativeContextContinuationTurn,
): Sha256Digest {
  return wireDigest(NativeContextContinuationTurnSchema.parse(turn));
}

export function nativeContextContinuationRequestDigest(
  request: NativeContextContinuationRequestMaterial,
): Sha256Digest {
  return wireDigest({
    turnDigest: request.turnDigest,
    run: request.run,
    expectedBoundary: request.expectedBoundary,
  });
}

export const NativeContextContinuationRequestSchema = z
  .strictObject({
    operationId: idSchema,
    requestDigest: sha256DigestSchema,
    turnDigest: sha256DigestSchema,
    run: AgentRunControlRefSchema,
    expectedBoundary: NativeContextBoundaryProofSchema,
  })
  .superRefine((request, refinement) => {
    const proof = request.expectedBoundary;
    if (
      request.run.runId !== proof.runId ||
      request.run.provider !== proof.provider ||
      request.run.environmentId !== proof.environmentId ||
      request.run.sessionId !== proof.sessionId
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["expectedBoundary"],
        message: "boundary proof must match the continued run",
      });
    }
    if (
      request.requestDigest !== nativeContextContinuationRequestDigest(request)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "native continuation request digest does not match its content",
      });
    }
  }) satisfies z.ZodType<NativeContextContinuationRequest>;

export const NativeContextContinuationAcknowledgementSchema = z
  .strictObject({
    operationId: idSchema,
    requestDigest: sha256DigestSchema,
    status: z.enum([
      "accepted",
      "replayed",
      "conflict",
      "boundary_mismatch",
      "unverified",
      "unknown_session",
      "transport_failure",
    ]),
    historyMessagesSent: z.number().int().nonnegative(),
    existingRequestDigest: sha256DigestSchema.optional(),
    actualBoundary: NativeContextBoundaryProofSchema.optional(),
    message: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
  })
  .superRefine((acknowledgement, refinement) => {
    if (
      acknowledgement.historyMessagesSent !== 0
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["historyMessagesSent"],
        message: "native continuation must never resend portable history",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.existingRequestDigest === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a continuation conflict must include the existing digest",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.existingRequestDigest === acknowledgement.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a continuation conflict must identify a different request",
      });
    }
    if (
      acknowledgement.status !== "conflict" &&
      acknowledgement.existingRequestDigest !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "only a continuation conflict may include an existing digest",
      });
    }
    if (
      acknowledgement.status === "transport_failure" &&
      acknowledgement.message === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["message"],
        message: "a continuation transport failure must include a message",
      });
    }
    if (
      acknowledgement.status === "transport_failure" &&
      acknowledgement.retryable === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "a continuation transport failure must state whether retry is safe",
      });
    }
    if (
      ["accepted", "replayed", "boundary_mismatch"].includes(
        acknowledgement.status,
      ) &&
      acknowledgement.actualBoundary === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["actualBoundary"],
        message: `${acknowledgement.status} must include the observed boundary`,
      });
    }
  });
export type NativeContextContinuationAcknowledgement = z.infer<
  typeof NativeContextContinuationAcknowledgementSchema
>;

/** Exact cross-check required before committing a transfer receipt. */
export function contextTransferReceiptMatches(
  request: ContextTransferRequest,
  receipt: ContextTransferReceipt,
): boolean {
  const parsedRequest = ContextTransferRequestSchema.safeParse(request);
  const parsedReceipt = ContextTransferReceiptSchema.safeParse(receipt);
  if (!parsedRequest.success || !parsedReceipt.success) return false;

  const exactRequest = parsedRequest.data;
  const exactReceipt = parsedReceipt.data;
  const included = exactRequest.plan.messages
    .filter((message) => message.action === "include")
    .map((message) => message.messageId)
    .sort();
  const omitted = exactRequest.plan.messages
    .filter((message) => message.action === "omit")
    .map((message) => message.messageId)
    .sort();
  const source = exactRequest.plan.context.source;
  const repeatsSourceSession =
    source.sessionId !== undefined &&
    exactReceipt.sessionId === source.sessionId &&
    (source.provider === undefined || exactReceipt.provider === source.provider) &&
    (source.environmentId === undefined ||
      exactReceipt.environmentId === source.environmentId);
  return (
    exactReceipt.operationId === exactRequest.operationId &&
    exactReceipt.requestDigest === exactRequest.requestDigest &&
    exactReceipt.planDigest === exactRequest.plan.digest &&
    exactReceipt.contextDigest === exactRequest.plan.context.digest &&
    wireDigest(exactReceipt.destination) ===
      wireDigest(exactRequest.plan.destination) &&
    (exactRequest.plan.destination.provider === undefined ||
      exactReceipt.provider === exactRequest.plan.destination.provider) &&
    exactReceipt.sessionCreatedForOperationId === exactRequest.operationId &&
    !repeatsSourceSession &&
    JSON.stringify([...exactReceipt.transferredMessageIds].sort()) ===
      JSON.stringify(included) &&
    JSON.stringify([...exactReceipt.omittedMessageIds].sort()) ===
      JSON.stringify(omitted)
  );
}

/** Exact cross-check required before accepting a native continuation result. */
export function nativeContextContinuationAcknowledgementMatches(
  request: NativeContextContinuationRequest,
  acknowledgement: NativeContextContinuationAcknowledgement,
): boolean {
  const parsedRequest = NativeContextContinuationRequestSchema.safeParse(request);
  const parsedAcknowledgement =
    NativeContextContinuationAcknowledgementSchema.safeParse(acknowledgement);
  if (!parsedRequest.success || !parsedAcknowledgement.success) return false;

  const exactRequest = parsedRequest.data;
  const exactAcknowledgement = parsedAcknowledgement.data;
  if (
    exactAcknowledgement.operationId !== exactRequest.operationId ||
    exactAcknowledgement.requestDigest !== exactRequest.requestDigest ||
    (exactAcknowledgement.status !== "accepted" &&
      exactAcknowledgement.status !== "replayed")
  ) {
    return false;
  }

  const actual = exactAcknowledgement.actualBoundary;
  if (actual !== undefined && !boundaryProofMatchesRun(exactRequest.run, actual)) {
    return false;
  }
  return (
    actual !== undefined &&
    Date.parse(actual.observedAt) >=
      Date.parse(exactRequest.expectedBoundary.observedAt) &&
    wireDigest(actual.boundary) ===
      wireDigest(exactRequest.expectedBoundary.boundary)
  );
}

function boundaryProofMatchesRun(
  run: AgentRunControlRef,
  proof: NativeContextBoundaryProof,
): boolean {
  return (
    proof.runId === run.runId &&
    proof.provider === run.provider &&
    proof.environmentId === run.environmentId &&
    proof.sessionId === run.sessionId
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}
