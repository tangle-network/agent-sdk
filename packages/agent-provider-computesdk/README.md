# @tangle-network/agent-provider-computesdk

Wraps a ComputeSDK-compatible `compute` object as an `AgentEnvironmentProvider`.

```ts
import { compute } from 'computesdk'
import { createComputeSdkProvider } from '@tangle-network/agent-provider-computesdk'

const provider = createComputeSdkProvider({
  compute,
  turnCommand: ({ prompt }) => `codex exec ${JSON.stringify(prompt ?? '')}`,
})
```
