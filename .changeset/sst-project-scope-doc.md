---
"@tangle-network/agent-core": patch
---

Correct the `SidecarSidScope` doc comment, which told consumers to deny a
`"project"` token on a session-addressed route.

Denying every scope but `"session"` there is the behaviour that got the first
version of the sidecar guard reverted: the read-only and terminal tokens carry
a project ref in `sid`, so the rule 403s all of them on every session route. A
`"project"` token means no session comparison is possible, and the route's own
capability policy decides.

Documentation only — no runtime change. The claim's handling in
`issueSidecarAccessToken` and `verifySidecarToken` is unchanged.
