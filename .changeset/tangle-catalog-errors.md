---
"@tangle-network/agent-provider-tangle": patch
---

Preserve backend catalog errors before provisioning instead of reporting missing capability support.
An absent backend still refuses required attachments without creating a sandbox.
