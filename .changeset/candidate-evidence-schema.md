---
"@tangle-network/agent-interface": patch
---

Give the candidate evidence schemas one owner for the rule that a captured artifact must be the canonical bytes of its material.
The execution-plan and outcome schema modules each built that check by hand, so the artifact-hash and empty-artifact refusals were stated twice; they now come from one place.
The published schemas accept and refuse exactly the same values, with the same issue paths and messages.
