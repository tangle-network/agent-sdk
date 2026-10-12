---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-cli-bridge": patch
"@tangle-network/agent-provider-daytona": patch
"@tangle-network/agent-provider-e2b": patch
"@tangle-network/agent-provider-computesdk": patch
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-testkit": minor
---

Add reference-only portable workspace snapshots to the existing workspace request and an explicit create capability. Requests bind both canonical file manifests and archives, including Git state, to the existing public source lease and policy identities. Embedded file bytes and competing workspace sources are refused.

Adapters without a qualified receiver refuse the request before credentials, allocation or native admission. Provider conformance checks that refusal after reconstruction and requires a restore fixture for advertised support. This contract does not claim a live provider restore until its deployed receiver is qualified.
