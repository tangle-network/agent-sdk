---
"@tangle-network/agent-interface": minor
---

Define source-bound measured prompt and skill improvements as ordered `AgentProfileDiff` patches without persisting full profiles.
Use `candidateDigest` as the activation record's single candidate identity field.
Remove the old question adapter types and helper; providers now emit `InteractionRequest` directly.
Require canonical runner names and remove shorthand runner aliases and normalization.
