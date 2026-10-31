---
"@tangle-network/agent-provider-tangle": patch
---

Launch a native-auth canonical turn without preparation when its profile is too large for one gateway request. Preparation posted the whole profile to create its session, so a worker profile over 1 MiB failed its first turn with HTTP 413 before any launch. The turn now takes the path every other turn takes, where the SDK stages the profile's files like create-time mounts.
