---
"@tangle-network/agent-interface": patch
"@tangle-network/agent-provider-tangle": patch
---

Accept stored-secret host bindings through environment creation and lower supported proxySecrets onto Sandbox SecretBinding entries without requiring an unserved receipt protocol. Expose the host secret manager for per-run creation, acknowledged updates when supported, and settlement deletion.
