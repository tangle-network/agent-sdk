---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-tangle": minor
---

Carry an egress policy and a billing owner on the generic environment create input.

`CreateAgentEnvironmentInput` gains `egress` and `billingOwner`, and `AgentEnvironmentCapabilities` gains an optional `create` document that names the egress modes a provider accepts and whether it carries a billing owner. A provider that cannot satisfy the requested mode must fail the create rather than weaken or widen the policy.

The Tangle provider maps both fields onto `CreateSandboxOptions.egressPolicy` and `CreateSandboxOptions.billingOwnerId`, and refuses a domain list outside `strict` mode instead of sending one Sandbox ignores. Callers no longer need a private `mapCreateInput` or a `SandboxClient` wrapper to reach either field.
