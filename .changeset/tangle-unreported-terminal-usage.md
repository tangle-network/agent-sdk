---
"@tangle-network/agent-provider-tangle": patch
---

Accept Agent Container terminal results that explicitly declare `unreported` usage with `tokensKnown: false`. Preserve their output and unknown token and cost semantics without emitting measured usage; contradictory, nonterminal, and invalid declarations remain refused.
