---
'@tangle-network/harness-sessions': patch
---

`readSessionInput` takes `firstLine`: the file line its input starts on, when the input continues a longer file. A record without an id of its own is named by its line, so records appended since a previous read keep the ids a read of the whole file gives them, without padding the input with one entry per earlier line.
