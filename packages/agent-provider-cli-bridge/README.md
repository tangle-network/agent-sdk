# @tangle-network/agent-provider-cli-bridge

Wraps a running `cli-bridge` server as an `AgentEnvironmentProvider`.

```ts
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'

const provider = createCliBridgeProvider({
  baseUrl: 'http://127.0.0.1:8787',
  bearerToken: process.env.CLI_BRIDGE_TOKEN,
  defaultModel: 'codex',
})
```

Response headers and streamed bodies have no transport timeout by default.
For unattended runs, set `headersTimeoutMs`, `bodyTimeoutMs`, or an `AbortSignal` so an unresponsive bridge cannot wait forever.
