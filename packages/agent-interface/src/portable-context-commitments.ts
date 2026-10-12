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
    source: {
      source: plan.source.source,
      digest: plan.source.digest,
      completeness: plan.source.completeness,
      messages: plan.source.messages.map((message) => ({
        messageId: message.id,
        metadataDigest: portableContextMessageMetadataDigest(message),
        parts: message.parts.map((part) => wireDigest(part)),
      })),
      attachments: plan.source.attachments.map((attachment) => ({
        messageId: attachment.messageId,
        partIndex: attachment.partIndex,
        digest: wireDigest(attachment),
      })),
    },
    destination: plan.destination,
    messages: plan.messages.map((message) => ({
      messageId: message.messageId,
      action: message.action,
      ...(message.reason === undefined ? {} : { reasonDigest: wireDigest(message.reason) }),
      parts: message.parts.map((part) => ({
        partIndex: part.partIndex,
        action: part.action,
        ...(part.reason === undefined ? {} : { reasonDigest: wireDigest(part.reason) }),
        ...(part.output === undefined ? {} : { outputDigest: wireDigest(part.output) }),
      })),
    })),
    context: plan.context,
    ...(plan.estimatedTokens === undefined ? {} : { estimatedTokens: plan.estimatedTokens }),
    requiresAcceptance: plan.requiresAcceptance,
  };
}
