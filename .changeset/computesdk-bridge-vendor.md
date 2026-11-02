---
"@tangle-network/agent-provider-computesdk": major
"@tangle-network/agent-provider-cli-bridge": patch
"@tangle-network/agent-provider-daytona": patch
---

`createComputeSdkProvider({ compute, router: { key } })` runs CLI Bridge from the box image on any computesdk backing provider through `createBridgeSandboxProvider`. `turnCommand`, `mapCreateInput`, `capabilities`, `name`, `ComputeSdkLike`, `ComputeSandboxLike` and `defaultComputeSdkCapabilities` are removed: a turn runs the profile's harness through the Bridge, never a shell command built from the prompt. The cli-bridge sandbox entry exports `markedExec`, `envFileLaunch` and `untilAborted`, which the Daytona and computesdk vendors share; the Daytona Bridge env file now sits in a directory only the box user can open.
