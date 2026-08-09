import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import type { BackendMessage } from "./backend-message.js";
import type { InputPart } from "./parts.js";
import {
  idSchema,
  InputPartSchema,
  sha256DigestSchema,
  sameStringSet,
  wireDigest,
} from "./portable-context-shared.js";
import { boundedStringSchema, CONTRACT_MAX_ARRAY_LENGTH } from "./contract-limits.js";
import { PortableConversationContextSchema, type PortableConversationContext } from "./portable-context-base.js";

export interface PortableContextDestination {
  runner: string;
  provider: string;
  environmentId: string;
  sessionId: string;
  runId: string;
  executionId: string;
  model?: string;
  profileDigest: Sha256Digest;
}

export const PortableContextDestinationSchema = z.strictObject({
  runner: idSchema,
  provider: idSchema,
  environmentId: idSchema,
  sessionId: idSchema,
  runId: idSchema,
  executionId: idSchema,
  model: idSchema.optional(),
  profileDigest: sha256DigestSchema,
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
    reason: boundedStringSchema.min(1).optional(),
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
    parts: z.array(PortableContextPartPlanSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
    reason: boundedStringSchema.min(1).optional(),
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

const PortableContextPlanMaterialSchema = z.strictObject({
  planId: idSchema,
  source: PortableConversationContextSchema,
  destination: PortableContextDestinationSchema,
  messages: z.array(PortableContextMessagePlanSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
  context: PortableConversationContextSchema,
  estimatedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  requiresAcceptance: z.boolean(),
});

export function portableContextPlanDigest(
  plan: PortableContextPlanMaterial,
): Sha256Digest {
  const parsed = PortableContextPlanMaterialSchema.parse(plan);
  return wireDigest({
    planId: parsed.planId,
    source: parsed.source,
    destination: parsed.destination,
    messages: parsed.messages,
    context: parsed.context,
    ...(parsed.estimatedTokens === undefined
      ? {}
      : { estimatedTokens: parsed.estimatedTokens }),
    requiresAcceptance: parsed.requiresAcceptance,
  });
}

export const PortableContextPlanSchema = z
  .strictObject({
    planId: idSchema,
    source: PortableConversationContextSchema,
    destination: PortableContextDestinationSchema,
    messages: z.array(PortableContextMessagePlanSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
    context: PortableConversationContextSchema,
    estimatedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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
