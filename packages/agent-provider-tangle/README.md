# @tangle-network/agent-provider-tangle

Wraps `@tangle-network/sandbox` as an `AgentEnvironmentProvider`.

```ts
import { Sandbox } from '@tangle-network/sandbox'
import { createTangleProvider } from '@tangle-network/agent-provider-tangle'

const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
})
```

Pass `exactProcess: {}` only when the Sandbox deployment supports `agent: false` creates and reports `metadata.runtimeMode: "control"`.
The optional capability creates an ephemeral sandbox with an authenticated control service but no managed agent workload or agent credentials, explicit resources, exact blocked/domain egress, bounded binary file reads, shell-free launch, and recoverable process output plus terminal reason.
Set `teamId` inside `exactProcess` to scope create, lookup, and recovery to one team.

```ts
const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
  exactProcess: {},
})

const environment = await provider.exactProcess!.create({
  image: 'ghcr.io/acme/agent@sha256:<64-hex-manifest-digest>',
  egress: { mode: 'blocked' },
  maxLifetimeMs: 120_000,
  resources: { cpu: 1, memoryMb: 1024, diskMb: 1024 },
  metadata: { executionId: 'run-1' },
  idempotencyKey: 'run-1',
})
```

The adapter rejects ordinary sandboxes during create, recovery, and list operations.
