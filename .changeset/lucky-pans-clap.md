---
"@tangle-network/agent-provider-tangle": minor
---

Derive retained control from deployment capability discovery.

Composing an environment now calls `box.capabilities()` once and takes the retained-control claim from that document instead of from the linked Sandbox SDK's method surface.
`retainedControl` needs `dispatch.runControlRef` with `cancel.canonicalRunCancellation`, `cancel.digestBound`, and `cancel.idempotent`; `streaming.detach` needs `dispatch.runControlRef`.
An SDK older than 0.22.0, a sandbox that is not running, a `null` document, or a missing flag claims nothing: the environment omits `dispatch` and its sessions omit `cancelRun`.
A malformed document throws and `create()` deletes the sandbox.
The client stage keeps its adapter-surface probe as an upper bound, because no deployment exists to ask before a sandbox is created.
