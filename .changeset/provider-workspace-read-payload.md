---
"@tangle-network/agent-provider-tangle": patch
---

Use the existing UTF-8 resource payload bound for workspace reads so Runtime can resolve source files beyond 16 KiB without model transcription.
Keep control-plane paths and oversized file reads bounded.
