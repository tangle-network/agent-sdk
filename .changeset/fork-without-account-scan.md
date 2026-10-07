---
"@tangle-network/agent-provider-tangle": patch
---

`fork` no longer pages the whole account to look for a child of a key the handle has not recorded. It creates with the same idempotency key, and Sandbox replays the child it already created for that key. On an account with thousands of sandboxes the search timed out or repeated rows, so a fork answered `unknown`. The same search was removed from `deleteCheckpoint` in #439. A confidential fork, which this provider can only recover, and `lookupFork` still search.
