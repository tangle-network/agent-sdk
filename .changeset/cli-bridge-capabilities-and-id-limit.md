---
"@tangle-network/agent-provider-cli-bridge": patch
---

The adapter keeps `create.runtimeAttachments.mcp` after Bridge capability discovery, so dispatches that carry runtime MCP attachments are no longer refused.
Environment ids up to the shared 512-character Agent Interface identifier limit are accepted, both minted and requested, and longer ids are refused with a message naming the limit.
