---
"@tangle-network/agent-core": minor
---

Add the `./server-timing` subpath: `parseServerTiming`, `parseServerTimingDurations` and `formatServerTiming`, the one Server-Timing header parse and format. It follows RFC 9110 quoted strings, so an escaped quote or backslash inside a `desc` no longer splits the header, and it imports nothing, so Node, browser and Worker bundles can use it.
