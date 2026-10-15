---
"@tangle-network/agent-provider-tangle": patch
---

Accept nullable capability responses from the Sandbox SDK so its client can be passed directly to createTangleProvider. A null response continues to refuse proxy-secret requests before credential resolution or sandbox creation.
