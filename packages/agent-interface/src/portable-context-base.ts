import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import type { BackendMessage } from "./backend-message.js";
import {
  BackendMessageSchema,
  idSchema,
  sha256DigestSchema,
  wireDigest,
} from "./portable-context-shared.js";

export interface PortableContextSourceBoundary {
  runId: string;
  messageId: string;
  provider: string;
  environmentId: string;
  sessionId: string;
  executionId: string;
  requestDigest: Sha256Digest;
  branchId?: string;
}

export const PortableContextSourceBoundarySchema = z.strictObject({
  runId: idSchema,
  messageId: idSchema,
  provider: idSchema,
  environmentId: idSchema,
  sessionId: idSchema,
  executionId: idSchema,
  requestDigest: sha256DigestSchema,
  branchId: idSchema.optional(),
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
  name: idSchema.optional(),
  mediaType: idSchema.optional(),
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
    messages: z.array(BackendMessageSchema).max(1_024),
    attachments: z.array(PortableContextAttachmentRefSchema).max(1_024),
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
