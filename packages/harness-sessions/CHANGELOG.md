# @tangle-network/harness-sessions

## 0.1.3

### Patch Changes

- b693b67: A Claude Code transcript that repeats a record it already wrote (a resumed subagent writes its whole prefix again with the same `uuid` and timestamp) is read once. The copies produced duplicate messages and duplicate model calls, so two spans shared one identity and `traces facts` rejected the session.

## 0.1.2

### Patch Changes

- 41d992d: Claude Code user records the harness wrote (`<local-command-caveat>`, `<local-command-stdout>`, `<task-notification>`, interrupt markers, `sdk-cli` entries) are now actor `injected` instead of `human`, and a typed slash command's text is the command (`/effort`, `/model opus`) rather than its `<command-name>` wrapper. The rules are exported as `claudeRecordIsMachine` and `claudeTypedPromptText` so consumers such as traces share one owner.

## 0.1.1

### Patch Changes

- 1b49150: Publish through the release workflow (trusted publishing). Version 0.1.0 is already on npm.
