import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import { idSchema, sha256DigestSchema, wireDigest } from "./portable-context-shared.js";
import { boundedStringSchema } from "./contract-limits.js";
import { PortableContextDestinationSchema, PortableContextPlanSchema, type PortableContextDestination, type PortableContextPlan } from "./portable-context-plan.js";
import { PortableConversationContextSchema, type PortableConversationContext } from "./portable-context-base.js";

export interface PortableContextPlanRequestMaterial {
  requestId: string;
  source: PortableConversationContext;
  destination: PortableContextDestination;
  maxInputTokens?: number;
}

const PortableContextPlanRequestMaterialSchema = z.strictObject({
  requestId: idSchema,
  source: PortableConversationContextSchema,
  destination: PortableContextDestinationSchema,
  maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export function portableContextPlanRequestDigest(
  request: PortableContextPlanRequestMaterial,
): Sha256Digest {
  const parsed = PortableContextPlanRequestMaterialSchema.parse(request);
  return wireDigest({
    requestId: parsed.requestId,
    source: parsed.source,
    destination: parsed.destination,
    ...(parsed.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: parsed.maxInputTokens }),
  });
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
    maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .superRefine((request, refinement) => {
    if (
      request.requestDigest !==
      portableContextPlanRequestDigest({
      source: request.source,
      destination: request.destination,
      maxInputTokens: request.maxInputTokens,
      requestId: request.requestId,
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
      estimatedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      suggestedBoundaryMessageId: idSchema.optional(),
      message: boundedStringSchema.min(1),
    }),
    z.strictObject({
      status: z.literal("unsupported"),
      ...portableContextPlanResultBinding,
      message: boundedStringSchema.min(1),
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
