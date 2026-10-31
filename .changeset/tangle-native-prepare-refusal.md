---
"@tangle-network/agent-provider-tangle": patch
---

Launch a native-auth canonical turn without preparation when the sidecar answers prepare with 409 "Concurrent public profile materialization is disabled". A sidecar with no public revision root served every such first turn with that refusal; any other prepare failure still fails the turn.
