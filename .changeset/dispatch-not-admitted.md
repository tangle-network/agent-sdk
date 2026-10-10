---
"@tangle-network/agent-provider-tangle": patch
---

Throw  (code ) when Sandbox answers a dispatch with  and a different execution id. The error carries ,  and . Nothing ran for the request, so a caller can treat it as a refusal before admission instead of an execution of unknown state. A different execution id from a dispatch that ran still throws the untyped error.
