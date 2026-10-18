---
"@tangle-network/agent-provider-tangle": minor
---

Accept `providerOptions.routing` at creation and send it as the Sandbox `backend.routing`, so an environment can pin its Tangle Router providers (`only`), disable fallbacks and require the exact model. Requires `@tangle-network/sandbox` 0.60.88 or later. Routing stays creation-only; the SDK refuses it on a turn.
