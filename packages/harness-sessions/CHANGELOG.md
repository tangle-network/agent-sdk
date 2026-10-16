# @tangle-network/harness-sessions

## 0.1.4

### Patch Changes

- 765b724: `codexReader.locate` finds every Codex session a HOME holds. It read only `~/.codex/sessions`, so archived rollouts (`archived_sessions/`), sibling homes such as `~/.codex-lane`, and acct account homes (`~/.config/agent-accounts/codex/<account>`) were invisible: 702 archived and 182 account-home sessions on one host. It now reads `sessions/` and `archived_sessions/` of every Codex home by the trace archive's rule, exported as `CODEX_HOME_RULE`, `isCodexHome(dir)` and `codexHomes(home)`: `.codex` and each `.codex-<name>`, each account home, the HOME itself when it is a Codex home (a fleet seat's `codex` passed as a store root), and, for the process's own HOME only, `$CODEX_HOME` and `$ACCT_CONFIG`. Homes that resolve to one directory count once, and a session copied into several homes is one ref, its largest copy. A lookup by id whose file name lacks the id reads the `session_meta` of each rollout modified since the id's UUIDv7 time.
  
  Every reader's `cwd` filter now matches on a path boundary (`withinPath`, exported): `/w/agent` no longer matches `/w/agent-dev-container`, which `startsWith` did.
- d5fe0a8: The OpenCode reader opens the SQLite store read-only where it lies instead of copying it. It copied the whole store (13 GB on one host) to the temp directory before reading it, and `traces --all` failed with ENOSPC after 235 s. A store with a write-ahead log is opened `mode=ro`, so a read sees the rows a running OpenCode has committed to the log and never writes the store or the log; a store without one is opened `immutable=1`, so nothing is created beside it. Only a store SQLite cannot open in place (a log with no `-shm` on read-only storage, or Node before 22.15) is still read from a private copy. An OpenCode session's `integrity.sourceFiles` entry is now `<store>#session=<id>` with a digest of the session's rows, not a digest of the whole store file.

## 0.1.3

### Patch Changes

- b693b67: A Claude Code transcript that repeats a record it already wrote (a resumed subagent writes its whole prefix again with the same `uuid` and timestamp) is read once. The copies produced duplicate messages and duplicate model calls, so two spans shared one identity and `traces facts` rejected the session.

## 0.1.2

### Patch Changes

- 41d992d: Claude Code user records the harness wrote (`<local-command-caveat>`, `<local-command-stdout>`, `<task-notification>`, interrupt markers, `sdk-cli` entries) are now actor `injected` instead of `human`, and a typed slash command's text is the command (`/effort`, `/model opus`) rather than its `<command-name>` wrapper. The rules are exported as `claudeRecordIsMachine` and `claudeTypedPromptText` so consumers such as traces share one owner.

## 0.1.1

### Patch Changes

- 1b49150: Publish through the release workflow (trusted publishing). Version 0.1.0 is already on npm.
