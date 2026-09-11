---
"@tangle-network/agent-interface": minor
---

Expose an immutable failure receipt for observed execution usage and timing.
Adapters can reject failed execution without discarding resource accounting.
Failure receipts do not assert that all usage was reported.
