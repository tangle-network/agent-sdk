---
"@tangle-network/agent-interface": patch
---

Preserve explicitly empty resource arrays when generating exact profile replacement diffs alongside changed resource siblings. Keep existing removal semantics and avoid copying unchanged nonempty or unresolved resources into replacement patches.
