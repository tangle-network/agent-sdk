---
"@tangle-network/agent-interface": minor
---

Add an optional normalized environment observation surface and an optional provider-neutral interactive-terminal contract.
Each observation carries a required freshness discriminator, so a missing value never reads as a measured zero, and the endpoint type holds no credential field.
All additions are optional and additive; a provider that declares neither surface still validates.
