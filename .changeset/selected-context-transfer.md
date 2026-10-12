---
"@tangle-network/agent-interface": major
"@tangle-network/agent-core": minor
"@tangle-network/agent-provider-cli-bridge": major
"@tangle-network/agent-provider-tangle": major
"@tangle-network/agent-provider-testkit": minor
---

Keep complete context plans local. Transfer only selected typed content and hash commitments, and verify the same accepted plan digest at the destination. Use `createContextTransferRequest` to project a local plan into the new wire contract. The plan digest algorithm and transfer plan shape change; receivers and consumers must upgrade together, with explicit recovery for earlier operation records.
