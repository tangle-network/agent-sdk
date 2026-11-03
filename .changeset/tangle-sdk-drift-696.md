---
"@tangle-network/agent-provider-tangle": patch
---

Re-pairs the provider's tests with Sandbox SDK 1.0.151: `/v1/backends` entries now require `callerCredentialOnly`, capability documents require a boolean `interactions.responseDedupe`, mapped create options require a JSON-form `backend`, turn-scoped secret launches carry `metadata.profileSecretIsolation` and run through the session-preparation seam, managed creates carry the default `cwd: "workspace"`, and the stored-secrets refusal message is "Tangle secrets require bounded explicit stored selection". `MAX_MACHINE_ID_LENGTH` left the SDK (machine identity moved to unbounded instance metadata) and its seam entry is retired with the reason recorded; the new raw-archive `MAX_OMIT_CONTENT_QUERY_BYTES` limit is paired as internal to the evidence download path.

Closes #696.
