---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-testkit": minor
---

Bind native same-session continuation requests to the exact new turn digest.
Add an optional provider capability and session operation that atomically verifies the boundary, durably admits one operation identifier and request digest, returns a runtime-validated result plus current control reference, replays that exact outcome after uncertain transport failures, and rejects changed input without dispatch.

Keep timeout and abort controls outside the digest-bound turn.
Extend portable-context conformance to prove exact turn binding, result and control-reference recovery, changed-turn conflict, and zero duplicate continuation effects.
