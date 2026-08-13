---
"@tangle-network/agent-provider-tangle": minor
---

Answer interactions through the retained Tangle session.

`environment.respondToInteraction()` and `session.respondToInteraction()` resolve one
outstanding ask with the canonical `InteractionResponseCommand`. A question maps onto
`session.answer()`, a permission onto `session.respondToPermission()`, and a plan onto
`session.approvePlan()` or `session.rejectPlan()`.

The adapter advertises `interactions` only when the deployed sidecar discloses
`interactions.responseDedupe: true` through `box.capabilities()`. Four outcomes leave the
deployment unknown: an SDK without that method, a document that omits the flag, a `null`
document, and a read that fails. The adapter then omits both methods. A failed read is
reported on the warning channel and never fails `create()`, so a sandbox is never
destroyed over a capability it could not read.

Every outcome maps onto a canonical acknowledgement status. A replayed operation returns
its stored acknowledgement, an identical later answer returns `already_resolved_same`, a
different answer returns `already_resolved_different`, a stale binding returns
`binding_mismatch`, and an ask this adapter never observed returns `unknown_interaction`.

An answer is delivered only where it can be aimed at the bound ask. `session.answer()`
carries no interaction id, so a question is answered only while it is the session's single
unresolved question. A plan carries no binding, so it is answered only when the stream that
raised it, or the answering session, proves its exact run. The resolution record is held
per environment id by the provider, so an environment rebuilt with `provider.get()` never
delivers a second time. `retryable` is claimed only from a shape that proves a transport
failure; an unattributed rejection is reported as terminal.
