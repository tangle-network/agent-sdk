---
"@tangle-network/agent-provider-cli-bridge": patch
---

A turn's `providerOptions.backend.runtimeAttachments` now travel in the Bridge's `runtime_attachments` field, with the turn's servers replacing the environment's servers of the same alias, on one-shot requests and on retained turns. The provider used to copy them into request `metadata` or `provider_options`. Agent Runtime puts its coordination attachment there when it dispatches a replacement into the prior session of an environment it reloaded by id. The attachment's `headers.Authorization` secret-ref is a credential-bearing key, so cli-bridge refused the replacement with HTTP 400, and one harness abort ended the run (drewstone/cli-bridge#394). The rest of the turn's `providerOptions` travel as before.
