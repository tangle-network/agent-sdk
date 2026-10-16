---
"@tangle-network/agent-trace-contract": minor
---

Say who acted on every span. `ATTR` gains `agent.profile.digest`, `agent.profile.name`, `agent.model`, `agent.harness`, `agent.skills.digest` and `agent.directive.variant`. Every builder takes an optional `agent: AgentIdentity` and stamps one key per non-empty field, never a placeholder; `agentIdentityAttributes(identity)` gives producers that build their own span shape the same keys under the same rule. `validateTraceSpans` reports a new `profile-attribution` capability, available when any span carries a usable `agent.profile.digest` or `agent.profile.name`. `PROFILE_ATTR_KEYS` lists those two keys for readers.
