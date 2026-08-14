---
"@tangle-network/agent-provider-cli-bridge": patch
---

Make retained CLI Bridge state authoritative for completion, cancellation, and replay.
Reject aggregate responses that do not match the accepted run identity.
Read cancelled retained state when a stream ends with only its protocol marker.
Consume rejected aggregate responses before returning identity errors.
