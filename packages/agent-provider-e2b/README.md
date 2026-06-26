# @tangle-network/agent-provider-e2b

Direct E2B adapter for `AgentEnvironmentProvider`.

```ts
import { createE2BProvider } from '@tangle-network/agent-provider-e2b'

const provider = createE2BProvider({
  turnCommand: ({ prompt }) => `codex exec ${JSON.stringify(prompt ?? '')}`,
})
```
