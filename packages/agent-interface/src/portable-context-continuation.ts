import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  AgentExactRunControlRefSchema,
  type AgentExactRunControlRef,
} from "./runtime-control.js";
import { idSchema, InputPartSchema, jsonRecordSchema, sha256DigestSchema, wireDigest } from "./portable-context-shared.js";
import { boundedStringSchema, CONTRACT_MAX_ARRAY_LENGTH } from "./contract-limits.js";

export const NativeContextBoundarySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("token"), token: idSchema }),
    z.strictObject({ kind: z.literal("revision"), revision: idSchema }),
    z.strictObject({ kind: z.literal("digest"), digest: sha256DigestSchema }),
    z.strictObject({
      kind: z.literal("messages"),
      messageIds: z.array(idSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
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
  executionId: idSchema,
  requestDigest: sha256DigestSchema,
  boundary: NativeContextBoundarySchema,
  observedAt: z.iso.datetime().max(64),
});
export type NativeContextBoundaryProof = z.infer<
  typeof NativeContextBoundaryProofSchema
>;

export interface NativeContextContinuationRequest {
  operationId: string;
  requestDigest: Sha256Digest;
  turnDigest: Sha256Digest;
  run: AgentExactRunControlRef;
  expectedBoundary: NativeContextBoundaryProof;
}

export interface NativeContextContinuationRequestMaterial {
  operationId: string;
  turnDigest: Sha256Digest;
  run: AgentExactRunControlRef;
  expectedBoundary: NativeContextBoundaryProof;
}

const NativeContextContinuationRequestMaterialSchema = z.strictObject({
  operationId: idSchema,
  turnDigest: sha256DigestSchema,
  run: AgentExactRunControlRefSchema,
  expectedBoundary: NativeContextBoundaryProofSchema,
});

/** JSON-stable user turn admitted by a native same-session continuation. */
export interface NativeContextContinuationTurn {
  prompt?: string;
  parts?: import("./parts.js").InputPart[];
  model?: string;
  context?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

export const NativeContextContinuationTurnSchema = z.strictObject({
  prompt: boundedStringSchema.optional(),
  parts: z.array(InputPartSchema).max(CONTRACT_MAX_ARRAY_LENGTH).optional(),
  model: idSchema.optional(),
  context: jsonRecordSchema.optional(),
  providerOptions: jsonRecordSchema.optional(),
}) satisfies z.ZodType<NativeContextContinuationTurn>;

/** Bind retry identity to the exact new user turn. */
export function nativeContextContinuationTurnDigest(
  turn: NativeContextContinuationTurn,
): Sha256Digest {
  return wireDigest(NativeContextContinuationTurnSchema.parse(turn));
}

export function nativeContextContinuationRequestDigest(
  request: NativeContextContinuationRequestMaterial,
): Sha256Digest {
  const parsed = NativeContextContinuationRequestMaterialSchema.parse(request);
  return wireDigest({
    turnDigest: parsed.turnDigest,
    operationId: parsed.operationId,
    run: parsed.run,
    expectedBoundary: parsed.expectedBoundary,
  });
}

export const NativeContextContinuationRequestSchema = z
  .strictObject({
    operationId: idSchema,
    requestDigest: sha256DigestSchema,
    turnDigest: sha256DigestSchema,
    run: AgentExactRunControlRefSchema,
    expectedBoundary: NativeContextBoundaryProofSchema,
  })
  .superRefine((request, refinement) => {
    const proof = request.expectedBoundary;
    if (
      request.run.runId !== proof.runId ||
      request.run.provider !== proof.provider ||
      request.run.environmentId !== proof.environmentId ||
      request.run.sessionId !== proof.sessionId ||
      request.run.executionId !== proof.executionId ||
      request.run.requestDigest !== proof.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["expectedBoundary"],
        message: "boundary proof must match the continued run",
      });
    }
    const { requestDigest: _requestDigest, ...material } = request;
    if (request.requestDigest !== nativeContextContinuationRequestDigest(material)) {
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
    historyMessagesSent: z.number().int().nonnegative().max(CONTRACT_MAX_ARRAY_LENGTH),
    existingRequestDigest: sha256DigestSchema.optional(),
    actualBoundary: NativeContextBoundaryProofSchema.optional(),
    message: boundedStringSchema.min(1).optional(),
    retryable: z.boolean().optional(),
  })
  .superRefine((acknowledgement, refinement) => {
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
    exactAcknowledgement.historyMessagesSent !== 0 ||
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
  run: AgentExactRunControlRef,
  proof: NativeContextBoundaryProof,
): boolean {
  return (
    proof.runId === run.runId &&
    proof.provider === run.provider &&
    proof.environmentId === run.environmentId &&
    proof.sessionId === run.sessionId &&
    proof.executionId === run.executionId &&
    proof.requestDigest === run.requestDigest
  );
}
