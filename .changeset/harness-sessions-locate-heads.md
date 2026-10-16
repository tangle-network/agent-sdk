---
'@tangle-network/harness-sessions': patch
---

`locate` reads each session file's head in 64 KB steps, with no digest, 32 files at a time. It used to stream and SHA-256 a megabyte of every file one after another, which made locating a store of 4,300 Claude Code sessions take 7.3 s on a loaded Mac; the same store now locates in about a second. Results are unchanged.
