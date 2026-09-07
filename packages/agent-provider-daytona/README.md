# @tangle-network/agent-provider-daytona

Direct Daytona adapter for `AgentEnvironmentProvider`.

```ts
import { createDaytonaProvider } from '@tangle-network/agent-provider-daytona'

const provider = createDaytonaProvider({
  turnCommand: ({ prompt }) => `codex exec ${JSON.stringify(prompt ?? '')}`,
})
```

Keyed creation is unsupported and rejects before provisioning.
The adapter cannot retain admission keys across process restarts or recover a lost create acknowledgement.
Use unkeyed creation only when the caller can manage that uncertainty.
