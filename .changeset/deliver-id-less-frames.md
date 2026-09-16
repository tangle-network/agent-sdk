---
"@tangle-network/agent-provider-tangle": patch
---

Deliver a session event that arrives without a stable id instead of ending the stream.

The sidecar stamps an SSE `id:` only on frames that have a replay-buffer position; a frame with no position carries no id by the SSE contract, so a reconnect resumes from the last frame that had one. The adapter refused any id-less frame as a contract violation and ended the whole event stream, which also lost the terminal `done` receipt that carries the execution's token usage. Three long pi turns on 2026-09-15 settled at zero tokens over 846 to 1693 seconds each for this reason. An id-less frame cannot be replayed, so it cannot arrive twice; it is now yielded without dedup and the cursor is left where it was.
