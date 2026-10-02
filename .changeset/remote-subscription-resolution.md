---
"@tangle-network/agent-provider-tangle": minor
---

Add a bounded HTTP resolver for remote subscription account owners.
Preserve exact profile intent, immutable create identity, and the fixed validity deadline.
Accept only public stored-secret references and keep narrow broker grants separate from Bridge launch credentials.
\nPreserve typed account-capacity metadata across HTTP and command transports. HTTP errors retain only their actual response status, and private diagnostics never enter public errors.\n