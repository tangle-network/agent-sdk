# @tangle-network/agent-provider-daytona

Direct Daytona adapter for `AgentEnvironmentProvider`.

```ts
import { createDaytonaProvider } from '@tangle-network/agent-provider-daytona'

const provider = createDaytonaProvider({
  turnCommand: ({ prompt }) => `codex exec ${JSON.stringify(prompt ?? '')}`,
})
```
