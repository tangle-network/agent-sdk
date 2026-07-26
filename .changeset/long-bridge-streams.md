---
"@tangle-network/agent-provider-cli-bridge": patch
---

Disable response-header and body-idle timeouts by default so long-running CLI sessions remain active until the caller aborts them.
