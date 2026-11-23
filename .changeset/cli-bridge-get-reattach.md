---
"@tangle-network/agent-provider-cli-bridge": patch
---

`get(id)` rebuilds an environment this provider created from its recorded create input, without that create call's signal. The rebuilt environment carries the create `metadata`, including Runtime's `retainedIdempotencyKey`, and can dispatch the same turn identity again, so after one failed observation a retained turn reattaches to the run the Bridge already holds. An environment created by another provider instance, or already destroyed, is reconstructed as before: no metadata and no dispatch.
