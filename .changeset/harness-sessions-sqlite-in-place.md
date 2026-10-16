---
'@tangle-network/harness-sessions': patch
---

The OpenCode reader opens the SQLite store read-only where it lies instead of copying it. It copied the whole store (13 GB on one host) to the temp directory before reading it, and `traces --all` failed with ENOSPC after 235 s. A store with a write-ahead log is opened `mode=ro`, so a read sees the rows a running OpenCode has committed to the log and never writes the store or the log; a store without one is opened `immutable=1`, so nothing is created beside it. Only a store SQLite cannot open in place (a log with no `-shm` on read-only storage, or Node before 22.15) is still read from a private copy. An OpenCode session's `integrity.sourceFiles` entry is now `<store>#session=<id>` with a digest of the session's rows, not a digest of the whole store file.
