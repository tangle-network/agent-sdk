---
"@tangle-network/agent-provider-tangle": minor
---

Answer an exact interaction through the Tangle provider.

`respondToInteraction` is offered on a Tangle environment and on a session
handle. It takes the canonical `InteractionResponseCommand` and returns the
canonical `InteractionAcknowledgement`, carrying the deployment's own durable
result: a repeated command reads as `already_resolved_same`, and a different
answer for a recorded ask reads as `already_resolved_different` with the
recorded digest named. A refusal is never reported as a success, and a
response the deployment records without confirming delivery is reported as
`transport_failure` rather than `accepted`.

The command carries only the answer the caller supplied. An answer that omits
a field the outstanding ask requires is refused with that field named, so no
value is invented for a question the caller did not answer.

The `interactions` capability is claimed only when the connected deployment
reports `interactions.responseDedupe`, because the adapter keeps no record of
its own and every replay answer comes from the deployment. An absent flag, a
`null` capability document, and an unreadable one all claim nothing.

The `@tangle-network/sandbox` peer floor moves to `>=0.23.0 <1.0.0`.
`session.respondToInteraction` first shipped in 0.23.0. The adapter
feature-detects it, so an older SDK claims no interactions; the floor stands
because the earlier answer path resolves the session's first outstanding
question rather than the one a response names, and this adapter never falls
back to it.
