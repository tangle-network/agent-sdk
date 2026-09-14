---
"@tangle-network/agent-provider-tangle": patch
---

Name the value that exceeded a JSON bound instead of throwing "value exceeds its JSON bound".

The error now carries which bound was exceeded, the JSON path to the offending value, its observed size and the limit, and never the value itself, since these payloads carry prompt text. A spawn refused for an oversized inline resource is now diagnosable from the error alone: a 20,872-character inline file against MAX_STRING_LENGTH 16,384 cost a research run all three of its children with nothing to read but the bare sentence.

No bound is widened and acceptance is unchanged, which a differential test pins across 4,013 values against the previous walker.
