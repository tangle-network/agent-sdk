---
"@tangle-network/agent-provider-tangle": patch
---

Bind a Sandbox event's session identity to the field position that carried it.
The run-frame position (`data.sessionId`) holds the harness-native session id on
`session.updated`, so an execution-bound stream keeps it as content. The
session-envelope position (`properties`/`properties.info`) holds the runtime
session id for every frame type and stays identity-checked. A `session.updated`
frame in either shape now reaches the normalized event with its session id,
title, and time.
