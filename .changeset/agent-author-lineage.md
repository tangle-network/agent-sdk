---
"@tangle-network/agent-interface": minor
---

feat(agent-interface): `agentCandidateLineageSchema` accepts a frontier-authored candidate

`AgentCandidateLineage.source` gains `frontier-author`: a profile one agent wrote for another. That is a shipped capability — a supervising agent authors a child's full `AgentProfile` from inside a run and may promote it to a sub-supervisor — and no existing member described it. `optimizer` was the closest and was closed to this caller by its own refinement, which mandates a `developmentSplitDigest`; a run-time author has no held-out split, so the field could only be satisfied by fabricating a digest or by declaring `human`.

The member is `frontier-author`, the word `AgentProfileDiff.source.kind` already uses for the same actor, so the two enums name one thing with one word rather than two.

`generatedCandidateSources` and `isGeneratedCandidateSource` are new exports and the single owner of "this candidate was produced from a parent". Three call sites — the lineage refinement and both experiment schemas — branched on `optimizer || compound` independently, so a new generated source was exempt from the "name your baseline" rule in two of them; they now read one list. The development split stays required by `optimizer` and `compound` only.

Additive: every lineage that parsed before parses unchanged.
