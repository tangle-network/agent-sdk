---
"@tangle-network/agent-core": patch
---

Preserve long timeout and Retry-After durations without native timer overflow. Remove abort listeners after completed sleeps and share the same cancellation-aware sleeper across retries and resilience utilities.
