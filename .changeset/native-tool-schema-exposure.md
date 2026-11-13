---
"@tangle-network/harness-sessions": patch
---

Preserve Claude Code's actual prompt snapshot tool definitions and bind each model response to the inventory observed before it. Retain schema changes as separate source snapshots; never backfill earlier responses from later definitions. Formats without recorded tool schemas remain explicitly unknown.

Verify every explicitly bound native conversation across retries through the shared family reader, and reject cyclic parentage instead of silently ignoring an already visited session.
