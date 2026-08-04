---
"@tangle-network/agent-core": patch
---

Allow callers to cancel retry backoff through `RetryConfig.signal` so an aborted operation never waits for or starts another attempt.
