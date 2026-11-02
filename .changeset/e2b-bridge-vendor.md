---
"@tangle-network/agent-provider-e2b": minor
"@tangle-network/agent-provider-cli-bridge": minor
---

`createE2BProvider({ apiKey?, router: { key } })` runs each environment as an E2B sandbox from the CLI Bridge box template through `createBridgeSandboxProvider`, so a profile that runs on Tangle runs on E2B. The `turnCommand`, `Sandbox`, `capabilities` and `mapCreateInput` options and `defaultE2BCapabilities` are removed. `BOX_TEMPLATE_NAME` names the E2B template and Daytona snapshot the image build publishes.
