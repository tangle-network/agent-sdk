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
Service-side truth for retained control needs the sidecar capability endpoint and is a follow-up; only the `interactions` claim reads that endpoint today.
A client that cannot prove those facts gets no claim, so the runtime rejects retained dispatch before any sandbox is created.
Each concrete sandbox narrows the declared document independently against its own measured method surface, so a capable sandbox keeps retained control even when the provider-level claim failed closed.

## Interaction responses

A parked run raises an ask: a question, a permission request, or a plan.
`environment.respondToInteraction(command)` and `session.respondToInteraction(command)` answer one ask with the canonical `InteractionResponseCommand`.

The adapter advertises `interactions` only when the deployment proves it.
It reads the deployed sidecar's `GET /capabilities` document through `box.capabilities()` and claims the capability only when `interactions.responseDedupe` is `true`.
Four outcomes leave the deployment unknown: an SDK without `box.capabilities()`, a document that omits the flag, a `null` document, and a read that fails.
The adapter withholds the claim and omits both methods for each of these, because an undisclosed deployment cannot prove a retry-safe response.
A failed read is reported on the process's warning channel and never fails `create()`: the read happens after the sandbox exists, and an unclaimed capability costs one unavailable method while a failed create costs the whole environment.
The provider-level document never claims `interactions`: the capability document is served per sandbox, and the provider boundary has no sandbox to read.

Each kind maps onto one Sandbox method: a question to `session.answer()`, a permission to `session.respondToPermission()`, and a plan to `session.approvePlan()` or `session.rejectPlan()`.
The adapter answers an ask only after it observed the ask on a stream, because the command names an interaction id but not its kind.
It checks the answer against the ask's binding and answer spec before any request leaves the process.
Three limits come from the Sandbox transport and appear in the claimed document.
`secretAnswers` is false, because the question route carries strings and cannot carry a one-use secret handle.
`concurrentRequests` is false, because `session.answer()` resolves the session's outstanding question and cannot select among several.
`responseScopes` names `interaction` alone, because the permission route carries the `allow_once` grant; the adapter refuses a broader grant instead of delivering it narrowed.

`session.answer()` carries no interaction id, so an answer reaches whichever question the runtime lists first.
The adapter therefore delivers an answer only when the bound ask is the session's single unresolved question, and refuses with `binding_mismatch` while another question is also unresolved.

A plan arrives as `plan.submitted` and carries no binding of its own.
Two coordinates can still prove its run: the exact run of the stream that carried the ask, and the run the answering session is bound to.
With neither, the adapter cannot tell this run from a foreign one, so it refuses the response instead of deciding the plan on an unchecked binding.
Observe plan asks on a run-bound stream — `environment.stream()` with an `executionId` or a `controlRef`, or `session.events()` on a session with a control reference — to keep plans answerable.

A resolution record belongs to the sandbox, not to one environment object: the provider holds one ledger per environment id, so an environment rebuilt with `provider.get()` answers a retry of a command the earlier object delivered instead of delivering it again.
Beyond the provider object the record is gone, and a retry then reaches the Sandbox route, whose durable resolution ledger the `interactions` claim requires, so the agent still receives one answer.
The runtime's verdict on that retry reaches the caller for a question: an answered question is no longer outstanding, so the SDK refuses it and the adapter reports `unknown_interaction` rather than a second `accepted`.
The permission route reports its replay in a response body that `session.respondToPermission()` discards, so a retried permission answer the sidecar replayed is reported `accepted`; the answer the ask holds is still exactly this one.

Each outcome maps onto one acknowledgement status.

| Outcome | Status |
| --- | --- |
| Sandbox method resolved the bound ask | `accepted` |
| Same operation id and command digest, already delivered by this provider | the stored acknowledgement |
| New operation id, same response, already delivered by this provider | `already_resolved_same` |
| Different response for an ask this provider resolved, or route `409 already_resolved_different` | `already_resolved_different` |
| Stale or foreign binding, or route `409 binding_mismatch` | `binding_mismatch` |
| Another question is unresolved, so `session.answer()` cannot select the bound ask | `binding_mismatch` |
| Plan observed on a stream bound to no exact run | `binding_mismatch` |
| Binding names another run than the ask was raised on | `unknown_run` |
| Unobserved ask, no outstanding question on the session, or route `410` or `404` | `unknown_interaction` |
| Ask withdrawn by `interaction.cancel` | `cancelled` |
| Answer spec rejected the response, or route `400` | `invalid_response` |
| Route `408`, `429`, `5xx`, or an SDK network error | `transport_failure`, `retryable: true` |
| Transport cannot carry the answer, route `501`, an unattributed `409`, or any rejection carrying no status | `transport_failure`, `retryable: false` |

`retryable` is claimed only from a shape that proves the request never reached the route or that the route asked for a retry.
A rejection this adapter cannot attribute is reported as terminal, because retrying an unattributed failure can land a stale answer on a later ask.

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
