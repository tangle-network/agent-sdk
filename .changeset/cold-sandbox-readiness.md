---
"@tangle-network/agent-provider-tangle": patch
---

Pass the configured Sandbox readiness timeout to the create request so cold image pulls can finish before the provider waits for a running environment.
