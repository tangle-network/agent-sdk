# @tangle-network/agent-provider-tangle

Wraps `@tangle-network/sandbox` as an `AgentEnvironmentProvider`.
The peer range is `>=0.19.6 <1.0.0`; retained-run cancellation (`session.cancelRun`) first shipped in 0.19.6, and this package is developed and tested against 0.21.1.

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

The provider claims `retainedControl` only from probed facts.
A lazy instance handle minted from the linked Sandbox SDK over the client's `fetch` transport must prove `dispatchPrompt`, `session`, and `cancelRun`, and the client must expose `get` for reconstruction; the probe sends no request and creates no resource.
The probe measures the linked SDK's method surface, not the connected service; retained-control claims still rest on that measurement alone.
A client that cannot prove those facts gets no claim, so the runtime rejects retained dispatch before any sandbox is created.
Each concrete sandbox narrows the declared document independently against its own measured method surface, so a capable sandbox keeps retained control even when the provider-level claim failed closed.

## Interaction responses

A parked run raises an ask: a question, a permission request, or a plan.
`environment.respondToInteraction(command)` and `session.respondToInteraction(command)` answer one ask with the canonical `InteractionResponseCommand`.

The adapter advertises `interactions` only when the deployment proves it.
It reads the deployed sidecar's `GET /capabilities` document through `box.capabilities()` and claims the capability only when `interactions.responseDedupe` is `true`.
An SDK without `box.capabilities()`, a document that omits the flag, and a `null` document all leave the deployment unknown.
The adapter withholds the claim and omits both methods for each of these, because an undisclosed deployment cannot prove a retry-safe response.
The provider-level document never claims `interactions`: the capability document is served per sandbox, and the provider boundary has no sandbox to read.

Each kind maps onto one Sandbox method: a question to `session.answer()`, a permission to `session.respondToPermission()`, and a plan to `session.approvePlan()` or `session.rejectPlan()`.
The adapter answers an ask only after it observed the ask on a stream, because the command names an interaction id but not its kind.
It checks the answer against the ask's binding and answer spec before any request leaves the process.
Three limits come from the Sandbox transport and appear in the claimed document.
`secretAnswers` is false, because the question route carries strings and cannot carry a one-use secret handle.
`concurrentRequests` is false, because `session.answer()` resolves the session's outstanding question and cannot select among several.
`responseScopes` names `interaction` alone, because the permission route carries the `allow_once` grant; the adapter refuses a broader grant instead of delivering it narrowed.

Each outcome maps onto one acknowledgement status.

| Outcome | Status |
| --- | --- |
| Sandbox method resolved | `accepted` |
| Same operation id and command digest, already delivered | the stored acknowledgement |
| New operation id, same response, already delivered | `already_resolved_same` |
| Different response for a resolved ask, or route `409 already_resolved_different` | `already_resolved_different` |
| Stale or foreign binding, or route `409 binding_mismatch` | `binding_mismatch` |
| Binding names another run | `unknown_run` |
| Unobserved ask, or route `410` or `404` | `unknown_interaction` |
| Ask withdrawn by `interaction.cancel` | `cancelled` |
| Answer spec rejected the response, or route `400` | `invalid_response` |
| Transport cannot carry the answer, or route `5xx` or `501` | `transport_failure` |

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
