---
"@tangle-network/agent-provider-cli-bridge": patch
---

Keep the Bridge's failure type and HTTP status on a failed stream's status event as `errorCode` and `statusCode`, so a consumer classifies a subscription refusal as a credential refusal instead of an unknown failure. Mark a usage receipt the Bridge estimated for a CLI that reported no usage with `tokensKnown: false`, so its counters are not settled as measured tokens.
