---
"@tangle-network/agent-core": minor
---

Validate the `cap` claim on sidecar access tokens, on both halves of the round
trip.

`cap` is the claim that decides authorization, and neither
`issueSidecarAccessToken` nor `verifySidecarToken` inspected it. Every value a
JSON claim can hold round-tripped intact: `cap: 42`, `cap: null`, `cap: {}`,
`cap: ["totally_made_up"]`, and — the one that mattered — `cap: "read"`, a bare
string. A consumer's `cap.includes("read")` degrades on a string into a
substring test, so `cap: "read"` satisfied a read gate and `cap: "terminal"`
would have satisfied a terminal gate. The non-array values instead threw a
`TypeError` out of the consumer's auth middleware, reporting a server fault
where the honest answer was "this token is malformed".

`SidecarCapability` is now derived from a `SIDECAR_CAPABILITIES` list, the same
way `SidecarSidScope` derives from `SIDECAR_SID_SCOPES`, so the type a caller
programs against and the set the verifier enforces cannot drift apart.

Fails closed on both sides. Minting throws unless `cap` is an array whose every
entry is a recognised capability; verification rejects such a token rather than
returning a claim a consumer cannot evaluate. `cap: []` stays valid and keeps
its meaning — "scoped to no capability", which consumers read as
deny-everything. An absent `cap` still means full scope, and a malformed value
is never coerced to absent.

Rollout: this only rejects values no issuer produces today, so a verifier may
ship ahead of any issuer change with no mixed window to manage. Adding a
capability to the vocabulary later is the breaking direction — a verifier
rejects a capability it does not recognise, so every verifier must be
**deployed** with the new value before any issuer stamps it. Sidecars are baked
container images that outlive an orchestrator roll, and token TTLs run from 15
minutes to 8 hours.
