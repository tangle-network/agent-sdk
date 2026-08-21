---
"@tangle-network/agent-interface": minor
---

Add the `child-task` stream event that reports a provider-native child task lifecycle with a stable `childId`, an optional `parentChildId`, a status, start and update times, optional runner, model, usage, and terminal reason, and a `sourceEventId` for replay deduplication.
The runtime schema validates it as a member of `CanonicalStreamEventSchema` and `RuntimeEventEnvelope`.

Add the optional `AgentEnvironment.creation` verdict (`created` | `replayed`) reporting what the create call that returned the object did.
The shared idempotency helper now returns a `replayed` view for every same-key call after the first, so a caller can decide whether a failed follow-up may destroy the environment.
