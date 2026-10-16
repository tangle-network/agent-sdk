---
'@tangle-network/harness-sessions': patch
---

`locate` reads each session file's head in 64 KB steps, with no digest, 32 files at a time. It used to stream and SHA-256 a megabyte of every file, one file after another: locating this Mac's 4,300 Claude Code sessions spent 7.3 s that way. Results are unchanged.
