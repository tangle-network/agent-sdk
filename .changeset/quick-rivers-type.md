---
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-testkit": patch
---

Send attached terminal input, resize, and close operations directly through the authenticated terminal connection.
Keep separate control validation for attach, prompt, and stop operations.
Permit stale terminal handles to close their own socket without changing the running process.
