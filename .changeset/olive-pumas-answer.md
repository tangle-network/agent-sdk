---
"@tangle-network/agent-provider-tangle": minor
---

Answer interactions through the retained Tangle session.

`environment.respondToInteraction()` and `session.respondToInteraction()` resolve one
outstanding ask with the canonical `InteractionResponseCommand`. A question maps onto
`session.answer()`, a permission onto `session.respondToPermission()`, and a plan onto
`session.approvePlan()` or `session.rejectPlan()`.

The adapter advertises `interactions` only when the deployed sidecar discloses
`interactions.responseDedupe: true` through `box.capabilities()`. An SDK without that
method, a document that omits the flag, and a `null` document all leave the deployment
unknown, and the adapter then omits both methods.

Every outcome maps onto a canonical acknowledgement status. A replayed operation returns
its stored acknowledgement, an identical later answer returns `already_resolved_same`, a
different answer returns `already_resolved_different`, a stale binding returns
`binding_mismatch`, and an ask this adapter never observed returns `unknown_interaction`.
