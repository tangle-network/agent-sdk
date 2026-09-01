---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-tangle": minor
---

Carry an egress policy and a billing owner on the generic environment create input.

`CreateAgentEnvironmentInput` gains `egress` and `billingOwner`, and `AgentEnvironmentCapabilities` gains an optional `create` document that names the egress modes a provider accepts and whether it carries a billing owner. Each member of that document is itself optional and the block must state at least one, so a provider that takes a billing owner but no caller-controlled egress says exactly that instead of advertising a mode it does not accept. A provider that cannot satisfy the requested mode must fail the create rather than weaken or widen the policy, and a strict allowlist entry that matches no host is rejected rather than trimmed.

The Tangle provider maps both fields onto `CreateSandboxOptions.egressPolicy` and `CreateSandboxOptions.billingOwnerId`, and refuses a domain list outside `strict` mode instead of sending one Sandbox ignores. Callers no longer need a private `mapCreateInput` or a `SandboxClient` wrapper to reach either field.
