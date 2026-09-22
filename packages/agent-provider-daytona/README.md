# @tangle-network/agent-provider-daytona

Direct Daytona adapter for `AgentEnvironmentProvider`.

```ts
import { createDaytonaProvider } from '@tangle-network/agent-provider-daytona'

const provider = createDaytonaProvider({
  turnCommand: ({ prompt }) => `codex exec ${JSON.stringify(prompt ?? '')}`,
})
```

This adapter does not advertise durable generic environment creation.
It rejects `idempotencyKey` and generic `secrets` because the adapter cannot prove those properties through Daytona's create API.
