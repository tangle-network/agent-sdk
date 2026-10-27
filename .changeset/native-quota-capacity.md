---
"@tangle-network/agent-provider-tangle": patch
---

A run that failed on the harness's exhausted subscription quota (`errorCode: "provider_quota_exhausted"`, as the Sandbox sidecar now reports it) throws `TangleCredentialCapacityError` with `code: "provider_quota_exhausted"`, `reason: "exhausted"`, its `resetAt` and status 429: the same typed refusal the credential owner gives before dispatch, instead of a failed turn carrying only the assistant's text.
