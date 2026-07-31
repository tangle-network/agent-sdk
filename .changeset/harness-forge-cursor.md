---
"@tangle-network/agent-interface": minor
---

Add `forge` and `cursor` to `HarnessType` / `harnessTypeSchema`.

Both ship full provider adapters downstream (`sdk-provider-forge`,
`sdk-provider-cursor`), but were absent from the canonical enum, which forced
agent-dev-container and agent-app to maintain divergent copies of the harness
taxonomy. They are multi-provider CLI runners with no vendor lock, so they carry
no entry in the capability tables and resolve as router-backed — matching the
behavior downstream already relied on.
