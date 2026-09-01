---
"@tangle-network/agent-provider-tangle": minor
"@tangle-network/agent-provider-testkit": minor
"@tangle-network/agent-interface": patch
---

Hold the Tangle provider's `create()` until the sandbox reports `running`, so it returns an environment that can accept a turn.
The Sandbox client waits by itself only when the create response reports `pending` or `provisioning`, and a sandbox that reports `running` is not usable until its filesystem incarnation is ready.
A sandbox that never reaches running fails the create call with the platform's reason, and `readyTimeoutMs` bounds the wait.

Forward `AgentTurnInput.providerOptions.backend` to the Sandbox prompt options, so a turn can select its model, its inline profile, or a session credential bundle.
Refuse a field the Sandbox prompt options do not declare, read an inline profile with `agentProfileSchema`, and bind the accepted options into the retained request digest without their bearer material.

State the readiness rule on `AgentEnvironmentProvider.create`, and require `running` in the provider conformance suite.
