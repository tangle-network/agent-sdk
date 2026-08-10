---
"@tangle-network/agent-core": minor
---

Add an `sst` claim to sidecar access tokens naming what `sid` holds.

`sid` is minted with two meanings — a session id for a session-runtime token,
a project ref for a project-scoped read-only one — and nothing on the token
distinguished them, so a consumer could not tell whether comparing `sid`
against a session id was an authorization check or a guaranteed mismatch.

`issueSidecarAccessToken` accepts `sst: "session" | "project"` and
`verifySidecarToken` returns it. Consumers must read the claim's absence as
"the meaning of `sid` is unknown, do not enforce", so tokens minted before
this change keep working. Sidecar token TTLs run from 15 minutes to 8 hours
depending on the mint path, so plan for a mixed window of that length.

Fails closed on both sides. Minting throws on an `sst` value no verifier
accepts, and on `sst` without a `sid` for it to describe. Verification rejects
a token whose `sst` is unrecognised or describes an empty or non-string `sid`,
rather than returning a value a consumer would read as "not session-scoped".
