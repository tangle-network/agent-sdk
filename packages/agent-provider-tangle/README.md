# @tangle-network/agent-provider-tangle

Wraps `@tangle-network/sandbox` as an `AgentEnvironmentProvider`.
The peer range is `>=0.19.6 <1.0.0`; retained-run cancellation (`session.cancelRun`) first shipped in 0.19.6, and this package is developed and tested against 0.22.0.
The floor stays at 0.19.6 although deployment capability discovery (`box.capabilities()`) needs 0.22.0: the adapter feature-detects that method, so a consumer on an older SDK keeps working and claims no retained control instead of failing to load.

```ts
import { Sandbox } from '@tangle-network/sandbox'
import { createTangleProvider } from '@tangle-network/agent-provider-tangle'

const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
})
```

Detached dispatch returns the immutable Sandbox execution receipt in `controlRef`.
The adapter validates its complete capability document and omits optional environment methods whose capabilities are disabled.
Reconstruct an exact session with `environment.session(reference.id, { controlRef: reference.controlRef })`; replay cursors are exclusive at both the agent interface and Sandbox session stream.
Result, replay, and cancel operations select that exact execution instead of whichever execution most recently changed the shared session.
Session status with an exact control reference reports a state only when the payload names that execution; a payload bound to a different or unnamed execution reports `unknown`.

Capabilities are derived in two stages, and each stage claims only what it can establish.

The client stage runs before any sandbox exists, so it can only measure the adapter surface.
A lazy instance handle minted from the linked Sandbox SDK over the client's `fetch` transport must prove `dispatchPrompt`, `session`, and `cancelRun`, and the client must expose `get` for reconstruction; the probe sends no request and creates no resource.
That handle measures the linked SDK's method surface, which is an upper bound and never a statement about the connected service.
A client that cannot prove those facts gets no claim, so the runtime rejects retained dispatch before any sandbox is created.

The sandbox stage reads deployment truth.
Composing an environment calls `box.capabilities()` once and derives the retained-control claim from that document, not from the linked SDK.
`retainedControl` needs `dispatch.runControlRef` together with `cancel.canonicalRunCancellation`, `cancel.digestBound`, and `cancel.idempotent`; `streaming.detach` needs `dispatch.runControlRef` alone, because detached dispatch carries the caller's exact reference and refuses a receipt that does not echo it.
A missing flag means unknown, and unknown is never a claim.
The adapter surface stays the ceiling: a deployment claim can only narrow what the client can execute, never widen it.

Four inputs claim nothing at all: a Sandbox SDK older than 0.22.0, a sandbox that is not running, a `null` document (a deployment predating capability discovery, or one serving a newer schema this SDK cannot read), and a document that leaves any required flag unset.
In each case the environment omits `dispatch` and its sessions omit `cancelRun`, so a caller never selects an action the deployment will reject.
A malformed document is different: capability discovery throws, `create()` deletes the sandbox it just made, and the error propagates.

Pass the SDK client itself when retained control matters.
An object-spread wrapper (`{ ...client }`) drops class prototype methods, including `fetch`, so the provider treats the wrapper as a non-SDK client and claims no retained control.
A wrapper must delegate the SDK methods instead of copying properties.
After `session.prompt()` admits another turn, that session object's `controlRef` advances only when Sandbox returns the requested execution ID; a mismatched receipt fails without advancing local state.
Sandbox keeps execution identifiers optional for older or unproven service paths, so this adapter fails closed when a dispatch or prompt does not return one and never falls back to latest-session state.
Sessions reconstructed without a control reference may start a new prompt, but result lookup, cancellation, and cursor replay fail before calling Sandbox because those operations could otherwise select the newest unrelated execution.
It also rejects `contextTransfer` and `nativeContinuation` inputs explicitly until those operations have native Sandbox support instead of silently dropping them.
The adapter never advertises `branching.checkpoint` or `branching.fork`.
Sandbox exposes `snapshot`, `listSnapshots`, `deleteSnapshot`, and `branch(count)` with different semantics; durable workspace branching stays unadvertised until the full `AgentWorkspaceBranching` contract — retry, lookup, conflict, and cleanup together — is implemented over that surface.

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
