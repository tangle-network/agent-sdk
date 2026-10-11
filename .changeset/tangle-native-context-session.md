---
"@tangle-network/agent-interface": major
"@tangle-network/agent-provider-cli-bridge": patch
---

Allow accepted context-transfer plans to leave provider-allocated environment identity unbound until the exact receipt. Bind the profile, workspace and resources to the transfer request digest. Runner session creation carries the caller session identifier and canonical accepted transfer request.
