---
'@tangle-network/harness-sessions': patch
---

`codexReader.locate` finds every Codex session a HOME holds. It read only `~/.codex/sessions`, so archived rollouts (`archived_sessions/`), sibling homes such as `~/.codex-lane`, and acct account homes (`~/.config/agent-accounts/codex/<account>`) were invisible: 702 archived and 182 account-home sessions on one host. It now reads `sessions/` and `archived_sessions/` of every Codex home by the trace archive's rule, exported as `CODEX_HOME_RULE`, `isCodexHome(dir)` and `codexHomes(home)`: `.codex` and each `.codex-<name>`, each account home, the HOME itself when it is a Codex home (a fleet seat's `codex` passed as a store root), and, for the process's own HOME only, `$CODEX_HOME` and `$ACCT_CONFIG`. Homes that resolve to one directory count once, and a session copied into several homes is one ref, its largest copy. A lookup by id whose file name lacks the id reads the `session_meta` of each rollout modified since the id's UUIDv7 time.

Every reader's `cwd` filter now matches on a path boundary (`withinPath`, exported): `/w/agent` no longer matches `/w/agent-dev-container`, which `startsWith` did.
