# @tangle-network/agent-provider-cli-bridge

Wraps a running `cli-bridge` server as an `AgentEnvironmentProvider`.

```ts
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'

const provider = createCliBridgeProvider({
  baseUrl: 'http://127.0.0.1:8787',
  bearerToken: process.env.CLI_BRIDGE_TOKEN,
})

const environment = await provider.create({
  profile: {
    name: 'researcher',
    harness: 'codex',
    model: { default: 'gpt-5' },
  },
})
```

The bridge model is selected from run data in this order: the turn, the provider default, or the profile's `harness` plus `model.default`.
Execution fails before network use when none is present.

Passing the same `sessionId` on later turns continues the same CLI conversation.
`executionId` gives a turn stable bridge identity, and `lastEventId` reattaches after a reader failure.
Stopping a reader or destroying the environment cancels every active bridge run and waits for terminal confirmation.

Response headers and streamed bodies have no transport timeout by default.
For unattended runs, set `headersTimeoutMs`, `bodyTimeoutMs`, or an `AbortSignal` so an unresponsive bridge cannot wait forever.
