---
"@tangle-network/agent-interface": minor
---

Add an optional `maxTotalTokens` execution limit for the accounted input and output token total.
Terminal model settlements now carry required accounted input tokens per call and the router's `usageWithinLimits` result.
The strict schemas reject missing or malformed accounting fields.
