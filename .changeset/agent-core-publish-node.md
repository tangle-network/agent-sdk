---
"@tangle-network/agent-core": patch
---

Publish the `@tangle-network/agent-core/node` subpath. 0.13.0 declared it for the source tree but left it out of the published export map, so `sha256Hex` and `shellQuote` could not be imported.
