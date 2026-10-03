---
"@tangle-network/agent-provider-tangle": patch
---

Keep the creation-selected account on later turns for Codex and Kimi subscription environments.
Per-turn account selection remains limited to Claude setup tokens; before this change every fresh Codex turn under a resolver failed.
