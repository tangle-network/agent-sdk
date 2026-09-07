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

Keyed creation is unsupported and rejects before provisioning.
The adapter cannot retain admission keys across process restarts or recover a lost create acknowledgement.
Use unkeyed creation only when the caller can manage that uncertainty.
