# @tangle-network/agent-provider-e2b

Direct E2B adapter for `AgentEnvironmentProvider`.

```ts
import { createE2BProvider } from '@tangle-network/agent-provider-e2b'

const provider = createE2BProvider({
  turnCommand: ({ prompt }) => `codex exec ${JSON.stringify(prompt ?? '')}`,
})
```

This adapter does not advertise durable generic environment creation.
It rejects `idempotencyKey` and generic `secrets` because the adapter cannot prove those properties through E2B's create API.
