---
"@tangle-network/agent-provider-cli-bridge": patch
---

Accept Runtime's detached dispatch control on native retained turns.

The provider keeps this local control out of the CLI Bridge request body.
Direct streamed turns still reject detached execution.
