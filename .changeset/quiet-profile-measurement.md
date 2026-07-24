---
"@tangle-network/agent-interface": minor
---

Define source-bound measured prompt and skill improvements as ordered `AgentProfileDiff` patches without persisting full profiles.
Rename the activation record's `candidateBundleDigest` field to `candidateDigest`; consumers of the 0.32.x wire format must update that field when adopting this 0.33.0 minor release.
