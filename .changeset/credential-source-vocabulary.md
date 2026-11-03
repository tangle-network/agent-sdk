---
"@tangle-network/agent-interface": patch
"@tangle-network/agent-provider-tangle": patch
---

The profile credential vocabulary is `router | api-key | subscription` (#440).

`credentialSource` is typed and parsed as the three real sources, with `managed` kept as a deprecated spelling of `router`: authored profiles carrying it keep parsing and their canonical digests are unchanged, and the first-seat agreement accepts either spelling against either default. The provider seam normalizes at the boundary (`profileCredentialSource` returns only the new vocabulary), the credential command and HTTP resolvers skip `router` (as they skipped `managed`), and the native-credential refusals speak `router`.

agent-runtime accepts the full vocabulary in its profile policy (paired PR); new authoring should say `router`.
