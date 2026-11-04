---
"@tangle-network/agent-provider-tangle": patch
---

A profile over the Sandbox gateway bound now refuses at spawn (PAYLOAD_TOO_LARGE) instead of only warning: create sends the whole profile, and a live 1.5 MB create answered 413.
