---
"@tangle-network/harness-sessions": patch
---

A read whose `signal` aborts before the session file is streamed (for example a deadline that fires while the file opens) now rejects with the `AbortError` only. Before, the file stream created on the aborted signal also emitted an `'error'` event with no listener, which crashed the process.
