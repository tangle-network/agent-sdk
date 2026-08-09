import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  boundedStringSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
} from "./contract-limits.js";
import {
  PortableContextSourceBoundarySchema,
} from "./portable-context-base.js";
import {
  PortableContextDestinationSchema,
  PortableContextPlanSchema,
  type PortableContextPlan,
} from "./portable-context-plan.js";
import { idSchema, sha256DigestSchema, wireDigest } from "./portable-context-shared.js";

export const ContextPlanAcceptanceSchema = z.strictObject({
  planDigest: sha256DigestSchema,
  acceptedAt: z.iso.datetime().max(64),
  acceptedBy: z.enum(["user", "policy", "system"]),
});
export type ContextPlanAcceptance = z.infer<
  typeof ContextPlanAcceptanceSchema
>;

export interface ContextTransferRequestMaterial {
  operationId: string;
  plan: PortableContextPlan;
  acceptance: ContextPlanAcceptance;
}

const ContextTransferRequestMaterialSchema = z.strictObject({
  operationId: idSchema,
  plan: PortableContextPlanSchema,
  acceptance: ContextPlanAcceptanceSchema,
});

export function contextTransferRequestDigest(
  request: ContextTransferRequestMaterial,
): Sha256Digest {
  const parsed = ContextTransferRequestMaterialSchema.parse(request);
  return wireDigest({
    operationId: parsed.operationId,
    planDigest: parsed.plan.digest,
    acceptance: parsed.acceptance,
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
    if (
      request.requestDigest !==
      contextTransferRequestDigest({
        operationId: request.operationId,
        plan: request.plan,
        acceptance: request.acceptance,
      })
    ) {
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
      source: PortableContextSourceBoundarySchema,
      destination: PortableContextDestinationSchema,
      provider: idSchema,
      environmentId: idSchema,
      sessionId: idSchema,
      runId: idSchema,
      executionId: idSchema,
      sessionCreatedForOperationId: idSchema,
      sessionCreatedAt: z.iso.datetime().max(64),
      transferredMessageIds: z.array(idSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
      omittedMessageIds: z.array(idSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
      admittedAt: z.iso.datetime().max(64),
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
  const source = exactRequest.plan.source;
  const destination = exactRequest.plan.destination;
  const createdAt = Date.parse(exactReceipt.sessionCreatedAt);
  const acceptedAt = Date.parse(exactRequest.acceptance.acceptedAt);
  const admittedAt = Date.parse(exactReceipt.admittedAt);
  return (
    createdAt >= acceptedAt &&
    createdAt <= admittedAt &&
    exactReceipt.operationId === exactRequest.operationId &&
    exactReceipt.requestDigest === exactRequest.requestDigest &&
    exactReceipt.planDigest === exactRequest.plan.digest &&
    exactReceipt.contextDigest === exactRequest.plan.context.digest &&
    wireDigest(exactReceipt.source) === wireDigest(source.source) &&
    wireDigest(exactReceipt.destination) === wireDigest(destination) &&
    exactReceipt.provider === destination.provider &&
    exactReceipt.environmentId === destination.environmentId &&
    exactReceipt.sessionId === destination.sessionId &&
    exactReceipt.runId === destination.runId &&
    exactReceipt.executionId === destination.executionId &&
    exactReceipt.sessionCreatedForOperationId === exactRequest.operationId &&
    exactReceipt.environmentId !== source.source.environmentId &&
    exactReceipt.sessionId !== source.source.sessionId &&
    exactReceipt.runId !== source.source.runId &&
    exactReceipt.executionId !== source.source.executionId &&
    JSON.stringify([...exactReceipt.transferredMessageIds].sort()) ===
      JSON.stringify(included) &&
    JSON.stringify([...exactReceipt.omittedMessageIds].sort()) ===
      JSON.stringify(omitted)
  );
}

export const ContextTransferResultSchema = z
  .discriminatedUnion("status", [
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
      message: boundedStringSchema.min(1),
      retryable: z.boolean(),
    }),
  ])
  .superRefine((result, refinement) => {
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
  if (exactResult.status === "accepted" || exactResult.status === "replayed") {
    return contextTransferReceiptMatches(exactRequest, exactResult);
  }
  return true;
}
