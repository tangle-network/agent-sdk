---
"@tangle-network/agent-provider-tangle": minor
---

Derive retained control from deployment capability discovery, and publish the result on the environment.

Composing an environment now calls `box.capabilities()` once and takes every deployment-decided claim from that document instead of from the linked Sandbox SDK's method surface.
The narrowed document is published as `environment.capabilities`, which is the document to read before offering an operation: the operations an environment exposes match it exactly, while `provider.capabilities()` states the adapter's ceiling before any sandbox exists.

Every flag the capability document carries now gates the claims it backs.
`streaming.detach` and `streaming.turnIdempotency` need `dispatch.runControlRef` with `dispatch.executionIdOnAdmission`; `streaming.replay` needs `runs.eventReplay`; `sessions.continue`, `retainedControl`, and `session.cancelRun` need those plus `cancel.canonicalRunCancellation`, `cancel.digestBound`, `cancel.idempotent`, and `runs.executionScopedStatus`.
Detached dispatch also needs a session handle, because a detached run is reachable only through one.

Four inputs claim nothing: an SDK older than 0.22.0, a sandbox that is not running, a `null` document, and a capability read that fails.
Such environments omit `dispatch` and `session`.
A document that leaves a flag unset drops the claims that flag gates and keeps the rest, so it can still carry `streaming.detach` and `streaming.replay`.
A failed read no longer fails `create()` and no longer deletes the sandbox a cold provision has already paid for; it claims nothing and reports the failure on the warning channel.
