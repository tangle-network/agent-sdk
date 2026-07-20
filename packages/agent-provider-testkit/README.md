# @tangle-network/agent-provider-testkit

Framework-neutral checks for packages that implement `AgentEnvironmentProvider`.

```ts
import {
  runAgentEnvironmentProviderConformance,
  runAgentExactProcessProviderLifecycleChecks,
} from '@tangle-network/agent-provider-testkit'

await runAgentEnvironmentProviderConformance({
  name: 'my-provider',
  createProvider: () => createMyProvider(),
})
```

The checks create an environment, stream one turn, verify terminal completion,
exercise declared workspace methods, and destroy the environment.

`runAgentExactProcessProviderLifecycleChecks()` checks idempotent create and collision rejection, bounded exact-byte file round trips, terminal reasons, output replay, recovery, lookup, and deletion.
It intentionally does not certify a provider's network isolation, secret handling, public exposure, or process-tree behavior; provider packages must prove those properties against their real infrastructure.
