---
"@tangle-network/agent-provider-cli-bridge": minor
---

Add the `./sandbox` entry: `createBridgeSandboxProvider` turns a vendor sandbox that runs CLI Bridge from the box image into a spec-conforming `AgentEnvironmentProvider`, delegating every turn to `createCliBridgeProvider`. It refuses unsupported create fields with a typed error that names the field, validates profiles with the shared materializer, bounds turns by `timeoutMs`, and destroys a sandbox whose create fails. `renderBoxDockerfile` renders the one box image from the registry's harness pins.
