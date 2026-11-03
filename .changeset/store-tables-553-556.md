---
"@tangle-network/harness-sessions": patch
---

The store tables declare every root the pinned CLIs write: claude-code gains the XDG layout (`.config/claude/projects`) beside the classic `.claude/projects`, and its reader locates both; codex declares the flat `archived_sessions` store its readers already walked, so catalog-keyed captures, probes and keepers stop treating archived rollouts as undeclared.

Closes #553. Closes #556.
