---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-tangle": patch
---

Add `deepFreeze` to `@tangle-network/agent-interface`.
It owns the rule that a validated value handed to a caller must not be writable afterwards, and it skips a value it has already visited so a self-referring value is frozen once instead of recursing until the stack runs out.

`snapshotAgentProfile`, `parseCertifiedContext`, the Tangle adapter's capability document, and the Tangle adapter's environment metadata snapshot now call it instead of keeping a private copy each.
Two of those copies had no such guard and exhausted the stack on a value that referred to itself.
