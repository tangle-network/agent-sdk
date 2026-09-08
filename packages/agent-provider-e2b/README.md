# @tangle-network/agent-provider-e2b

Direct E2B adapter for `AgentEnvironmentProvider`.

```ts
import { createE2BProvider } from '@tangle-network/agent-provider-e2b'

const provider = createE2BProvider({
  turnCommand: ({ prompt }) => `codex exec ${JSON.stringify(prompt ?? '')}`,
})
```

Keyed creation is unsupported and rejects before provisioning.
The adapter cannot retain admission keys across process restarts or recover a lost create acknowledgement.
Use unkeyed creation only when the caller can manage that uncertainty.
