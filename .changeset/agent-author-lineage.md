---
"@tangle-network/agent-interface": minor
---

feat(agent-interface): `agentCandidateLineageSchema` accepts an agent-authored candidate

`source` gains `agent-author`: a profile that one agent wrote for another from inside a run. That is a shipped capability — a supervising agent authors a child's full `AgentProfile` and may promote it to a sub-supervisor — and no existing member described it. `optimizer` was the closest and was closed to this caller by its own refinement, which mandates a `developmentSplitDigest`; a run-time author has no held-out split, so the field could only be satisfied by fabricating a digest or by declaring `human`.

`agent-author` keeps the two requirements that make a generated lineage checkable — it names at least one parent and the run that produced it — and drops the development split, which now applies to `optimizer` and `compound` only. Additive: every lineage that parsed before parses unchanged.
