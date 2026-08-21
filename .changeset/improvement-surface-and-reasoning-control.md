---
"@tangle-network/agent-interface": minor
---

Give the improvement-surface list and the native reasoning control one owner each.

`AgentImprovementSurface` is now derived from the exported `AGENT_IMPROVEMENT_SURFACES` list, which the promotion schema's enum also reads, and it gains `rollout-policy`. A rollout-policy improvement can now be named in a proposal; before, `improve()` could produce a surface no proposal could report.

`nativeReasoningControl(harness, effort)` returns the exact control token a harness process receives — the value a materialization receipt carries as `reasoningEffort.applied`. Adapters that build harness argv and callers that verify the receipt now read one table instead of two hand-rolled copies that had already drifted apart. A harness with no native control answers `null`.
