import { z } from "zod";
import { CONTRACT_MAX_ARRAY_LENGTH } from "./contract-limits.js";
import { PortableContextSourceBoundarySchema, PortableConversationContextSchema } from "./portable-context-base.js";
import { portableContextMessageMetadataDigest, portableContextPlanCommitmentMaterial } from "./portable-context-commitments.js";
import { PortableContextDestinationSchema, PortableContextPlanSchema, type PortableContextPlan } from "./portable-context-plan.js";
import { idSchema, InputPartSchema, sameStringSet, sha256DigestSchema, wireDigest } from "./portable-context-shared.js";

const partDecisionSchema = z.strictObject({
  partIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  action: z.enum(["include", "transform", "omit"]),
  reasonDigest: sha256DigestSchema.optional(),
  outputDigest: sha256DigestSchema.optional(),
}).superRefine((part, refinement) => {
  if ((part.action === "transform") !== (part.outputDigest !== undefined) ||
    (part.action !== "include" && part.reasonDigest === undefined)) {
    refinement.addIssue({ code: "custom", message: "transformed parts require output and reason commitments; omitted parts require a reason" });
  }
});

const messageDecisionSchema = z.strictObject({
  messageId: idSchema,
  action: z.enum(["include", "omit"]),
  reasonDigest: sha256DigestSchema.optional(),
  parts: z.array(partDecisionSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
}).superRefine((message, refinement) => {
  if (message.action === "omit" && (message.reasonDigest === undefined || message.parts.some((part) => part.action !== "omit"))) {
    refinement.addIssue({ code: "custom", message: "omitted messages require a reason and must omit every part" });
  }
});

/** Destination wire plan. The complete source and human explanations remain at the caller. */
export const PortableContextTransferPlanSchema = z.strictObject({
  kind: z.literal("portable-context-transfer-plan"),
  planId: idSchema,
  source: z.strictObject({
    source: PortableContextSourceBoundarySchema,
    digest: sha256DigestSchema,
    completeness: z.enum(["complete", "partial"]),
    messages: z.array(z.strictObject({
      messageId: idSchema,
      metadataDigest: sha256DigestSchema,
      parts: z.array(sha256DigestSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
    })).max(CONTRACT_MAX_ARRAY_LENGTH),
    attachments: z.array(z.strictObject({
      messageId: idSchema,
      partIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      digest: sha256DigestSchema,
    })).max(CONTRACT_MAX_ARRAY_LENGTH),
  }),
  destination: PortableContextDestinationSchema,
  messages: z.array(messageDecisionSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
  context: PortableConversationContextSchema,
  estimatedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  requiresAcceptance: z.boolean(),
  digest: sha256DigestSchema,
}).superRefine((plan, refinement) => {
  const invalid = (message: string) => refinement.addIssue({ code: "custom", message });
  const sourceIds = plan.source.messages.map((message) => message.messageId);
  const decisionIds = plan.messages.map((message) => message.messageId);
  if (new Set(sourceIds).size !== sourceIds.length || new Set(decisionIds).size !== decisionIds.length || !sameStringSet(sourceIds, decisionIds)) {
    invalid("a transfer plan must decide every source message exactly once");
    return;
  }
  if (wireDigest(plan.source.source) !== wireDigest(plan.context.source)) invalid("output context source must match the immutable source");
  const outputIds: string[] = [];
  const expectedAttachments: typeof plan.context.attachments = [];
  for (const source of plan.source.messages) {
    const decision = plan.messages.find((message) => message.messageId === source.messageId)!;
    const ordered = [...decision.parts].sort((left, right) => left.partIndex - right.partIndex);
    if (ordered.length !== source.parts.length || ordered.some((part, index) => part.partIndex !== index)) {
      invalid("each source part requires exactly one transfer decision");
      continue;
    }
    if (decision.action === "omit") continue;
    outputIds.push(source.messageId);
    const output = plan.context.messages.find((message) => message.id === source.messageId);
    const retained = ordered.filter((part) => part.action !== "omit");
    if (!output || portableContextMessageMetadataDigest(output) !== source.metadataDigest || retained.length === 0 || output.parts.length !== retained.length) {
      invalid("selected message metadata and part count must match the source commitments");
      continue;
    }
    for (const [outputIndex, part] of retained.entries()) {
      const value = output.parts[outputIndex];
      if (!InputPartSchema.safeParse(value).success || wireDigest(value) !== (part.action === "transform" ? part.outputDigest : source.parts[part.partIndex])) {
        invalid("selected part bytes must match the accepted source or transform commitment");
      }

    }
  }
  if (JSON.stringify(outputIds) !== JSON.stringify(plan.context.messages.map((message) => message.id))) invalid("selected messages must retain source order");
  for (const attachment of plan.source.attachments) {
    const message = plan.source.messages.find((item) => item.messageId === attachment.messageId);
    if (message === undefined || attachment.partIndex >= message.parts.length) {
      invalid("attachment commitment must reference a source part");
      continue;
    }
    const decision = plan.messages.find((item) => item.messageId === attachment.messageId)!;
    const retained = [...decision.parts].sort((a, b) => a.partIndex - b.partIndex).filter((part) => part.action !== "omit");
    const outputIndex = retained.findIndex((part) => part.partIndex === attachment.partIndex);
    if (decision.action !== "include" || retained[outputIndex]?.action !== "include") continue;
    const selected = plan.context.attachments.find((item) => item.messageId === attachment.messageId && item.partIndex === outputIndex && wireDigest({ ...item, partIndex: attachment.partIndex }) === attachment.digest);
    if (selected === undefined) invalid("selected attachment must match its source commitment");
    else expectedAttachments.push(selected);
  }
  if (wireDigest(expectedAttachments) !== wireDigest(plan.context.attachments)) invalid("output attachments must exactly match the selected source parts");

  const changes = plan.messages.some((message) => message.action === "omit" || message.parts.some((part) => part.action !== "include"));
  const partial = changes || plan.source.completeness === "partial";
  if (plan.context.completeness !== (partial ? "partial" : "complete") || plan.requiresAcceptance !== partial) invalid("changed or partial context requires explicit acceptance");
  const { digest, ...material } = plan;
  if (digest !== wireDigest(material)) invalid("portable transfer plan digest does not match its commitments");
});

export type PortableContextTransferPlan = z.infer<typeof PortableContextTransferPlanSchema>;

export function portableContextTransferPlanDigest(material: Omit<PortableContextTransferPlan, "digest">) {
  return wireDigest(material);
}

export function projectPortableContextPlan(plan: PortableContextPlan): PortableContextTransferPlan {
  const exact = PortableContextPlanSchema.parse(plan);
  return PortableContextTransferPlanSchema.parse({ ...portableContextPlanCommitmentMaterial(exact), digest: exact.digest });
}
