# @tangle-network/agent-provider-testkit

Framework-neutral checks for packages that implement `AgentEnvironmentProvider`.

```ts
import { runAgentEnvironmentProviderConformance } from '@tangle-network/agent-provider-testkit'

await runAgentEnvironmentProviderConformance({
  name: 'my-provider',
  createProvider: () => createMyProvider(),
})
```

The checks create an environment, stream one turn, verify terminal completion,
exercise declared workspace methods, and destroy the environment.
