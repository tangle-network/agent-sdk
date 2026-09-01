---
"@tangle-network/agent-provider-tangle": minor
"@tangle-network/agent-provider-testkit": minor
"@tangle-network/agent-interface": patch
---

Hold the Tangle provider's `create()` until the sandbox is running, so it returns an environment that can accept a turn.
A sandbox that never reaches running fails the create call with the platform's reason, and `readyTimeoutMs` bounds the wait.

Forward `AgentTurnInput.providerOptions.backend` to the Sandbox prompt options, so a turn can select its model, its inline profile, or a session credential bundle.
Refuse a field the Sandbox prompt options do not declare, and bind the accepted options into the retained request digest.

State the readiness rule on `AgentEnvironmentProvider.create`, and check it in the provider conformance suite.
