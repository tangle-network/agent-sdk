---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-computesdk": patch
"@tangle-network/agent-provider-daytona": patch
"@tangle-network/agent-provider-e2b": patch
---

Add `commandTurnEvents`, `execResultFromUnknown`, and `execOnlyEnvironmentCapabilities` to `@tangle-network/agent-interface/environment-provider`.
They own the three rules every workspace-only environment adapter needs: the order a turn's command is resolved in and the refusal when none resolves, the two names a sandbox SDK can give an exit status, captured output, and captured errors, and the capability document of an adapter that runs commands and moves files but owns no agent profile, stream, session, or branch.

The ComputeSDK, Daytona, and E2B adapters now call those three instead of keeping a private copy each.
Their published capability documents, turn events, and refusal messages are unchanged.
