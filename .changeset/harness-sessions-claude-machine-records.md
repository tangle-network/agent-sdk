---
'@tangle-network/harness-sessions': patch
---

Claude Code user records the harness wrote (`<local-command-caveat>`, `<local-command-stdout>`, `<task-notification>`, interrupt markers, `sdk-cli` entries) are now actor `injected` instead of `human`, and a typed slash command's text is the command (`/effort`, `/model opus`) rather than its `<command-name>` wrapper. The rules are exported as `claudeRecordIsMachine` and `claudeTypedPromptText` so consumers such as traces share one owner.
