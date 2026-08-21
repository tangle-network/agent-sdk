---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-cli-bridge": patch
---

Add `sameAgentRunControlRef` to `@tangle-network/agent-interface`.
It owns the question "do these two references name the same run", and answers it over the reference's canonical form rather than a list of field names, so a reference that gains a coordinate is compared on it without a caller having to remember.

The two cancellation and control acknowledgement matchers and the cli-bridge adapter's retained control and native continuation checks now call it instead of comparing by hand.
