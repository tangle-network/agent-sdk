# @tangle-network/harness-sessions

## 0.3.0

### Minor Changes

- Move to the new breaking release of a dependency. This is a minor release, so `^0.x` consumers stay on the previous line until they move.
  
  - `@tangle-network/harness-sessions` depends on the breaking release of `@tangle-network/agent-core`.

### Patch Changes

- Updated dependencies [dffc705]
  - @tangle-network/agent-core@0.14.0

## 0.2.1

### Patch Changes

- 1b27839: Discover Kimi's recorded child wire files with exact native parent IDs, preserve direct-file child binding, and exclude wrapped child events from parent usage. Prove the read-to-OTLP path with redacted real captures and document explicit Pi and Factory Droid child-evidence limits.

## 0.2.0

### Minor Changes

- Move to the new breaking release of a dependency. This is a minor release, so `^0.x` consumers stay on the previous line until they move.
  
  - `@tangle-network/harness-sessions` depends on the breaking release of `@tangle-network/agent-core`.

### Patch Changes

- c3c9372: Use `isRecord` from `@tangle-network/agent-core` instead of a private copy.
- Updated dependencies [7611296]
  - @tangle-network/agent-core@0.13.0

## 0.1.7

### Patch Changes

- c925203: Codex `exec_command` (and `write_stdin`, and code-mode `exec` calls that run `tools.exec_command`) now take their span status from the recorded exit code instead of always reading as completed.

## 0.1.6

### Patch Changes

- d901d1d: `readSessionInput` takes `firstLine`: the file line its input starts on, when the input continues a longer file. A record without an id of its own is named by its line, so records appended since a previous read keep the ids a read of the whole file gives them, without padding the input with one entry per earlier line.

## 0.1.5

### Patch Changes

- b187cd5: `locate` reads each session file's head in 64 KB steps, with no digest, 32 files at a time. It used to stream and SHA-256 a megabyte of every file, one file after another: locating this Mac's 4,300 Claude Code sessions spent 7.3 s that way. Results are unchanged.

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
