import {
  AgentRuntimeAttachmentsSchema,
  type AgentProfile,
  type AgentRuntimeAttachments,
} from "@tangle-network/agent-interface";

/** Runtime bindings retain their own identity and cannot replace profile tools. */
export function tangleRuntimeAttachments(
  value: unknown,
  profile?: AgentProfile,
): AgentRuntimeAttachments {
  const attachments = AgentRuntimeAttachmentsSchema.parse(value);
  for (const [alias, server] of Object.entries(attachments.mcp)) {
    if (server.enabled === false) {
      throw new Error(`Tangle runtime MCP attachment cannot be disabled: ${alias}`);
    }
    if (Object.hasOwn(profile?.mcp ?? {}, alias)) {
      throw new Error(`Tangle runtime MCP attachment conflicts with profile: ${alias}`);
    }
  }
  return attachments;
}
