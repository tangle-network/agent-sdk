---
'@tangle-network/harness-sessions': patch
---

Codex `exec_command` (and `write_stdin`, and code-mode `exec` calls that run `tools.exec_command`) now take their span status from the recorded exit code instead of always reading as completed.
