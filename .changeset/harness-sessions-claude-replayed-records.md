---
'@tangle-network/harness-sessions': patch
---

A Claude Code transcript that repeats a record it already wrote (a resumed subagent writes its whole prefix again with the same `uuid` and timestamp) is read once. The copies produced duplicate messages and duplicate model calls, so two spans shared one identity and `traces facts` rejected the session.
