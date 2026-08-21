---
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-cli-bridge": patch
"@tangle-network/agent-provider-testkit": patch
---

Report the `AgentEnvironment.creation` verdict: the Tangle provider maps the platform create receipt, the CLI Bridge provider states `created` for the call that builds the environment handle, and the provider conformance rejects a same-key replay that claims it created the environment.
