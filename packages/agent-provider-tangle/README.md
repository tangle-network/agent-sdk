# @tangle-network/agent-provider-tangle

Wraps `@tangle-network/sandbox` 0.17 or newer as an `AgentEnvironmentProvider`.

```ts
import { Sandbox } from '@tangle-network/sandbox'
import { createTangleProvider } from '@tangle-network/agent-provider-tangle'

const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
})
```

Detached dispatch returns the immutable Sandbox execution receipt in `controlRef`.
The adapter validates its complete capability document and omits optional environment methods whose capabilities are disabled.
Reconstruct an exact session with `environment.session(reference.id, { controlRef: reference.controlRef })`; replay cursors are exclusive at the agent interface even though the Sandbox stream is inclusive.
Result, replay, and cancel operations select that exact execution instead of whichever execution most recently changed the shared session.
After `session.prompt()` admits another turn, that session object's `controlRef` advances only when Sandbox returns the requested execution ID; a mismatched receipt fails without advancing local state.
Sandbox keeps execution identifiers optional for older or unproven service paths, so this adapter fails closed when a dispatch or prompt does not return one and never falls back to latest-session state.
Sessions reconstructed without a control reference may start a new prompt, but result lookup, cancellation, and cursor replay fail before calling Sandbox because those operations could otherwise select the newest unrelated execution.
It also rejects `contextTransfer` and `nativeContinuation` inputs explicitly until those operations have native Sandbox support instead of silently dropping them.
The default adapter does not advertise legacy checkpoint or fork operations because Sandbox 0.17 exposes snapshots and branches with different semantics.
A custom compatible client may opt into the legacy methods explicitly; durable workspace branching remains unadvertised until checkpoint lookup, retry, conflict, and cleanup are implemented together.

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

## Braid runtime contracts

The adapter consumes Agent Interface 0.42.1 control types directly.

Detached dispatch, session status, per-run replay, terminal result lookup, prompt input, queued steer input, and cancellation remain bound to the returned `sessionId` and `executionId`.

The adapter never creates a runtime execution ID, event ID, timestamp, placement claim, usage count, attestation verdict, source reference, or capability receipt when the Sandbox runtime did not return one.

Replay requires an exact execution control reference and converts the Sandbox SDK's inclusive cursor to the Agent Interface's exclusive cursor.

`session.cancel()` calls exact execution cancellation and never calls `environment.destroy()`.

When the Sandbox session exposes the W4 interaction endpoints, `respondToInteraction()` sends the canonical response command with the runtime execution binding and returns the canonical acknowledgement, including retry, conflict, expiry, and transport statuses.

When the Sandbox instance exposes context transfer, native boundary, or durable workspace operations, the adapter validates every request and receipt against the shared Agent Interface schemas before returning it.

The optional `profileReceipt`, `profileDigest`, `evidence()`, and `attestation()` surfaces preserve profile, effective capability, placement, resource usage, and confidentiality evidence without upgrading unverified evidence to a verified claim.

Durable checkpoint and fork operations are exposed as `workspaceBranching` only when checkpoint, fork, lookup, retry identity, and cleanup are all present together.

Unsupported operations and ambiguous replay are rejected before the Sandbox call.
