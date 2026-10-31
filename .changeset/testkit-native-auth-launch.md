---
"@tangle-network/agent-provider-testkit": patch
---

Add the `nativeAuth` option to `runLiveProfileConformance`: it runs a turn that carries native CLI auth and fails MOD-4 if the turn dies on a sidecar's refusal to prepare its profile. Without the fixture MOD-4 reports unproven, and a missing credential reports `no credential: <NAME>`.
