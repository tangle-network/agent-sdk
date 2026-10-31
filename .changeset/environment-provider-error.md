---
"@tangle-network/agent-interface": minor
---

Add `EnvironmentProviderError` and the closed `EnvironmentProviderErrorCode` set so every environment provider reports refusal, capacity, authentication, transport, timeout and abort failures with a stable code, a scrubbed bounded message and the vendor error as `cause`.
