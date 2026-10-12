import type { BackendMessage } from "./backend-message.js";
import type { PortableContextPlanMaterial } from "./portable-context-plan.js";
import { wireDigest } from "./portable-context-shared.js";

export function portableContextMessageMetadataDigest(message: BackendMessage) {
  const { parts: _parts, ...metadata } = message;
  return wireDigest(metadata);
}

/** Bind the full local source and decisions without sending omitted bytes or explanation text. */
export function portableContextPlanCommitmentMaterial(plan: PortableContextPlanMaterial) {
  return {
    kind: "portable-context-transfer-plan" as const,
    planId: plan.planId,
    reviewDigest: wireDigest({ source: plan.source, messages: plan.messages }),
    source: {
      source: plan.source.source,
      digest: plan.source.digest,
      completeness: plan.source.completeness,
      messages: plan.source.messages.map((message) => {
        const decision = plan.messages.find((item) => item.messageId === message.id);
        return {
          messageId: message.id,
          ...(decision?.action === "include" ? { metadataDigest: portableContextMessageMetadataDigest(message) } : {}),
          parts: message.parts.map((part, partIndex) => decision?.action === "include" &&
            decision.parts.find((item) => item.partIndex === partIndex)?.action === "include" ? wireDigest(part) : null),
        };
      }),
      attachments: plan.source.attachments.filter((attachment) => {
        const decision = plan.messages.find((item) => item.messageId === attachment.messageId);
        return decision?.action === "include" && decision.parts.find((part) => part.partIndex === attachment.partIndex)?.action === "include";
      }).map((attachment) => ({
        messageId: attachment.messageId,
        partIndex: attachment.partIndex,
        digest: wireDigest(attachment),
      })),
    },
    destination: plan.destination,
    messages: plan.messages.map((message) => ({
      messageId: message.messageId,
      action: message.action,
      parts: message.parts.map((part) => ({
        partIndex: part.partIndex,
        action: part.action,
        ...(part.output === undefined ? {} : { outputDigest: wireDigest(part.output) }),
      })),
    })),
    context: plan.context,
    ...(plan.estimatedTokens === undefined ? {} : { estimatedTokens: plan.estimatedTokens }),
    requiresAcceptance: plan.requiresAcceptance,
  };
}
