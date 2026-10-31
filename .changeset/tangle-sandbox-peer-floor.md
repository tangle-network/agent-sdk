---
"@tangle-network/agent-provider-tangle": patch
---

Require Sandbox 1.0.151 or later. Sandbox 1.0.141 fails a turn that carries a profile whose files exceed one gateway request, because its file-mount delivery cannot read its upload manifest; 1.0.151 delivers it.
