---
"@tangle-network/agent-provider-tangle": patch
---

The default create mapping uses the inline profile's harness when the caller and provider declare no backend override.
Custom mappers retain control of the Sandbox options.
Created environment capabilities use the mapped backend.
Tangle snapshots create requests and mapped options before asynchronous work.
