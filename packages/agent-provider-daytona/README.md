# @tangle-network/agent-provider-daytona

Direct Daytona adapter for `AgentEnvironmentProvider`.

```ts
import { createDaytonaProvider } from '@tangle-network/agent-provider-daytona'

const provider = createDaytonaProvider({
  turnCommand: ({ prompt }) => `codex exec ${JSON.stringify(prompt ?? '')}`,
})
```

Persist an acknowledged environment ID to recover that same sandbox after a process restart:

```ts
const environment = await provider.get(recordedEnvironmentId)
if (environment === null) throw new Error('The recorded Daytona sandbox no longer exists')
if (await environment.status() !== 'running') {
  throw new Error('Resume the recorded sandbox through Daytona before continuing')
}
const result = await environment.exec('git status --short', { cwd: '/workspace' })
```

Recovery accepts an exact sandbox ID. Daytona's SDK also accepts names, but the adapter rejects a lookup that returns a different ID. A structured HTTP 404 returns `null`; authentication, transport, and service errors remain errors. Recovery never creates a replacement or starts a stopped sandbox. `status()` refreshes the SDK's sandbox data when available and reports stopped, failed, expired, pending, provisioning, and unknown states explicitly. `exec()` refuses a sandbox that is not running. A stopped, paused, or archived sandbox must be resumed through Daytona's lifecycle API using its recorded ID.

Creation waits for the SDK's startup completion and requires a running result. An acknowledged unkeyed create states `creation: 'created'`; a recovered environment has no creation verdict and does not grant cleanup ownership. Destruction requires a delete API and never substitutes a stop operation, which would leave retained storage behind.

Keyed creation remains unsupported and rejects before provisioning, including after adapter reconstruction. The adapter cannot recover a lost unkeyed create acknowledgement when no environment ID was recorded. Do not retry an uncertain unkeyed create automatically.

Durable keyed admission needs a provider service operation that atomically binds an operation key to the canonical create request digest, exposes the exact admitted sandbox ID for lookup after a lost response, and preserves that binding after rename or deletion. A same-key changed request must fail before provisioning; a deleted result must never create a replacement under the old key. Sandbox names and mutable labels do not establish those guarantees. The public [Daytona create contract](https://www.daytona.io/docs/en/typescript-sdk/daytona/#create) does not provide this operation contract.

This adapter provides command execution and workspace access. Its capability document does not claim canonical AgentProfile materialization, retained agent sessions, event replay, interactions, native continuation, or portable context transfer. A configured `turnCommand` runs through the shared command execution adapter; it is not evidence of those capabilities. Braid integration must negotiate those contracts through agent-runtime before admitting a conversation handoff.
