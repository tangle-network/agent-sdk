---
"@tangle-network/agent-provider-tangle": patch
---

Recover a live checkpoint from its owner-scoped operation record when snapshot inventory omits provider marker tags.
Never revive a deleted snapshot from a stale durable operation record.
