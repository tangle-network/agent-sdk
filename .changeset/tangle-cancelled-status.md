---
"@tangle-network/agent-provider-tangle": patch
---

Report a cancelled Tangle run as `cancelled` on the event stream.

`statusFromSandboxValue` mapped `cancelled` to `failed`, so a caller cancellation
and a run error reached the consumer as one state. The session status surface
already keeps them apart, so the same cancellation rendered differently
depending on which surface a consumer read, and differently again from an
identically cancelled CLI Bridge run.

The local `CanonicalStatus` union is replaced by `StreamStatus` from
`@tangle-network/agent-interface`. The duplicate union is what let the two
contracts drift: a widening of the shared type could not reach this file.
