---
"@tangle-network/agent-interface": minor
---

Expose the shared authorized candidate artifact reader for context-transfer attempts. Allow durable read-only context-transfer lookup independently of fresh admission, and declare transfer-only workspace snapshot support separately from ordinary create. Fresh admission, attachment, and snapshot transfer retain their required idempotency and lookup guarantees.
