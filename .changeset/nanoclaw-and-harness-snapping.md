---
"@tangle-network/agent-interface": minor
---

Make agent-interface the single source of truth for harness↔model snapping, and correct nanoclaw's capabilities.

- `nanoclaw` is now treated as router-backed (runs any model via the Tangle router) instead of Anthropic-locked, and its reasoning ceiling is `none` (its runner sends no thinking flag) instead of `ultracode`.
- Add `snapModelToHarness(harness, modelId, candidateIds)` and `snapHarnessToModel(harness, modelId)` so consumers (sandbox-ui, agent-app) import the catalog-aware snap logic instead of hand-rolling divergent copies.
