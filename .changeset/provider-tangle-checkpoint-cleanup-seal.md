---
"@tangle-network/agent-provider-tangle": patch
---

Checkpoint cleanup deletes a sealed checkpoint again. A cleanup target that matches exactly one snapshot by its `seal.<id>` alias, carries this source's checkpoint marker and has a succeeded checkpoint operation naming that id is deleted by the physical snapshot id Sandbox lists. Two witnesses, an unmarked snapshot or another source's marker still answer `unknown` with no delete. Each `unknown` acknowledgement names the step that answered it: `inventory unavailable`, `ambiguous seal alias`, `invalid snapshot metadata`, `not marked by this source`, `operation not confirmed`, or the delete's `deletion not attested`.
