---
"@tangle-network/agent-interface": patch
"@tangle-network/agent-provider-tangle": patch
---

Add authored per-profile outputFile policy and optional exact retained-file publication through the provider environment contract. Tangle delegates stopped capture and immutable regular-file receipts to the Sandbox SDK; missing source authority or a lost acknowledgment returns unavailable without recapturing a later invocation.
