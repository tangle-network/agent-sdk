---
"@tangle-network/agent-core": minor
---

Add `isRecord` to the root entry and `sha256Hex` and `shellQuote` in the new Node-only `@tangle-network/agent-core/node` subpath, so repos stop keeping their own copies. `sleep` and `withTimeout` were already exported from `./resilience`.
