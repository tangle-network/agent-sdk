---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-testkit": minor
---

Add the environment-scoped capability document.

`AgentEnvironment.capabilities` is an optional document that describes one environment.
A capability the connected deployment decides cannot be stated by `AgentEnvironmentProvider.capabilities()`, because one provider reaches deployments of different ages; a provider that measures such a capability per environment publishes the measured answer here, and the operations that environment exposes match it.

`runAgentEnvironmentProviderConformance` and `runSessionReplayConformance` now bind every environment-scoped check to that document when the environment publishes one, and to the provider document otherwise.
The provider report gains `environmentCapabilities`, which is the document the checks ran against.
