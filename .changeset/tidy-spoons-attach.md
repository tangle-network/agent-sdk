---
"@tangle-network/agent-provider-tangle": patch
---

Use the Sandbox exact interactive handle for start, control, terminal attach, prompt, status, and stop operations.
Replay an exited interactive session after its write lease expires without changing its identity.
Reconstruct control-bound Sandbox handles from persisted claims before interactive mutations.
Recover a fork child by exact identifier when its first acknowledgement omits durable provider metadata.
Remove only a confirmed-new child when the platform cannot preserve its recovery marker.
