---
"@tangle-network/agent-provider-daytona": minor
---

`createDaytonaProvider({ router: { key } })` now runs each environment as a Daytona sandbox created from the CLI Bridge box snapshot, so a profile that runs on Tangle runs on Daytona unchanged. Create fields Daytona cannot honor are refused with `EnvironmentProviderError` before any Daytona call. The `turnCommand`, `daytona`, `Daytona`, `config`, `capabilities` and `mapCreateInput` options and `defaultDaytonaCapabilities` are removed; `@daytonaio/sdk` is now a dependency.
