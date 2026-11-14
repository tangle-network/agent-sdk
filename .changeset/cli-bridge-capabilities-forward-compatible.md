---
"@tangle-network/agent-interface": patch
"@tangle-network/agent-provider-cli-bridge": patch
---

`AgentEnvironmentCapabilities` accepts an optional boolean `modelReroutes`: the stream reports a served-model reroute when it happens, as the CLI Bridge declares on `GET /v1/capabilities`. The CLI Bridge provider's capability discovery now drops keys it does not know, at any depth, instead of failing on a document from a newer Bridge; every known key is still validated strictly, and the shared schema stays strict for every other reader.
