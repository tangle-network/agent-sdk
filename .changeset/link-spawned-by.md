---
"@tangle-network/agent-trace-contract": minor
---

Add the `spawned_by` link kind: a child agent's session points at the parent's call that started it, so a reader follows a spawn tree by links instead of a cross-trace parent edge.
