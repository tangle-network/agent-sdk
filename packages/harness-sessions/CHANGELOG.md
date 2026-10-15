# @tangle-network/harness-sessions

## 0.1.2

### Patch Changes

- 41d992d: Claude Code user records the harness wrote (`<local-command-caveat>`, `<local-command-stdout>`, `<task-notification>`, interrupt markers, `sdk-cli` entries) are now actor `injected` instead of `human`, and a typed slash command's text is the command (`/effort`, `/model opus`) rather than its `<command-name>` wrapper. The rules are exported as `claudeRecordIsMachine` and `claudeTypedPromptText` so consumers such as traces share one owner.

## 0.1.1

### Patch Changes

- 1b49150: Publish through the release workflow (trusted publishing). Version 0.1.0 is already on npm.
