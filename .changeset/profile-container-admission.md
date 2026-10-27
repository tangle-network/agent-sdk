---
"@tangle-network/agent-interface": minor
---

Admit profile collections before element validation and record-key copying using the shared contract limits. Preserve typed training and knowledge limits, strict-object schema APIs and canonical identity. Snapshot validation now precedes the detached copy; opaque metadata must be bounded portable data without accessors.

`canonicalAgentProfileValue`, `canonicalAgentProfileJson` and `canonicalAgentProfileDigest` now refuse accessor properties instead of reading them, and every profile-value refusal is an exported `AgentProfileValueError` carrying the offending path; profile metadata parse issues report that nested path and reason.
