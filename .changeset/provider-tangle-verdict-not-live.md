---
"@tangle-network/agent-provider-tangle": patch
---

validateProfile runs the Sandbox pre-box verdict (`validateProfileForCreate`, Sandbox SDK 1.0.216+): an unsupported plan, such as a codex reader asking for no tools, refuses the spawn with PROFILE_UNSUPPORTED before any box. Reconnect to a box the Sandbox reports failed or deleted returns null, and interactive stop acknowledges effect not_live, so Runtime replaces it.
