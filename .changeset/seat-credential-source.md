---
"@tangle-network/agent-interface": patch
---

`AgentProfileSeat.credentialSource` lets one seat stage carry its own credential intent (`subscription` or `managed`); omitted, it inherits `profile.model.metadata.credentialSource`. A first stage that names one must match the profile's effective source.
