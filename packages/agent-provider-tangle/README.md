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
Created and reconstructed environments expose a recursively frozen Sandbox metadata snapshot for constant-time annotation checks.
Sandbox metadata can include caller-authored values and does not authenticate its author.
Reconstruct an exact session with `environment.session(reference.id, { controlRef: reference.controlRef })`; replay cursors are exclusive at both the agent interface and Sandbox session stream.
Result, replay, and cancel operations select that exact execution instead of whichever execution most recently changed the shared session.
Session status with an exact control reference reports a state only when the payload names that execution; a payload bound to a different or unnamed execution reports `unknown`.

## Two capability documents

Capabilities are derived in two stages, and the two stages answer different questions.

`provider.capabilities()` answers "what can this provider do against a deployment that backs it".
It runs before any sandbox exists, so it measures the adapter surface alone and states the adapter's ceiling for everything a deployment decides.
A lazy instance handle minted from the linked Sandbox SDK over the client's `fetch` transport must prove `dispatchPrompt`, `session`, and `cancelRun`, and the client must expose `get` for reconstruction; the probe sends no request and creates no resource.
That handle measures the linked SDK's method surface, never the connected service.
A client that cannot prove those facts gets no retained-control claim, so the runtime rejects retained dispatch before any sandbox is created.

`environment.capabilities` answers "what can this environment do", and it is the document to read before offering an operation.
Composing an environment calls `box.capabilities()` once and derives every deployment-decided claim from that document.
The operations an environment exposes match its own document exactly: a claim the document does not carry has no method behind it.
One provider reaches deployments of different ages, which is why the environment carries its own document rather than inheriting the provider's.

Each deployment flag this adapter reads gates the claims it backs, and no flag is read that gates nothing:

| Deployment flag | Claims it gates |
| --- | --- |
| `dispatch.runControlRef` | `streaming.detach`, `streaming.turnIdempotency`, `sessions.continue`, `retainedControl`, `session.cancelRun` |
| `dispatch.executionIdOnAdmission` | `streaming.detach`, `streaming.turnIdempotency`, `sessions.continue`, `retainedControl`, `session.cancelRun` |
| `cancel.canonicalRunCancellation` | `sessions.continue`, `retainedControl`, `session.cancelRun` |
| `cancel.digestBound` | `sessions.continue`, `retainedControl`, `session.cancelRun` |
| `cancel.idempotent` | `sessions.continue`, `retainedControl`, `session.cancelRun` |
| `runs.eventReplay` | `streaming.replay`, `sessions.continue`, `retainedControl`, `session.cancelRun` |
| `runs.executionScopedStatus` | `sessions.continue`, `retainedControl`, `session.cancelRun` |

Detached dispatch carries the caller's exact reference and refuses a receipt that does not name the execution back, so it needs both `dispatch` flags and a session handle to reach the run through.
`sessions.continue`, `retainedControl`, and `session.cancelRun` need every flag in the table, because the capability schema refuses a partial retained-control block and each identity rests on its own flag.
A claim takes its operation with it: `streaming.detach` gates `dispatch()`, and `session()` stands while any of `streaming.detach`, `streaming.replay`, or `sessions.continue` stands.
A missing flag means unknown, and unknown is never a claim.

Four inputs claim nothing at all: a Sandbox SDK older than 0.22.0, a sandbox that is not running, a `null` document (a deployment predating capability discovery, or one serving a newer schema this SDK cannot read), and a capability read that fails.
In each case the environment omits `dispatch` and `session`, so a caller never selects an action the deployment will reject.
A document that leaves a flag unset is not one of them.
It drops the claims that flag gates and keeps every claim its remaining flags back.
A document without `cancel.digestBound` still carries `streaming.detach` and `streaming.replay`, and its environment still exposes `dispatch` and `session`.
A failed read claims nothing rather than failing `create()`: discovery runs against a sandbox a cold provision has already paid for, and a transport failure is not evidence about the deployment.
The failure is reported on the warning channel.

The document is measured once, when the environment is composed.
A sandbox that is not yet running cannot answer, so an environment composed during provisioning claims nothing and keeps claiming nothing — the exposed operations and the document are composed together, and a caller may already hold either one.
Compose the environment again through `provider.get(id)` once the sandbox is running.

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
