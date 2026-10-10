---
"@tangle-network/agent-provider-tangle": patch
---

Throw `TangleDispatchNotAdmittedError` (code `DISPATCH_NOT_ADMITTED`) when Sandbox answers a dispatch with `dispatched: false` and a different execution id. The error carries `sessionId`, `requestedExecutionId` and `activeExecutionId`. Nothing ran for the request, so a caller can treat it as a refusal before admission instead of an execution of unknown state. A different execution id from a dispatch that ran still throws the untyped error.
