# @tangle-network/agent-provider-tangle

Wraps `@tangle-network/sandbox` as an `AgentEnvironmentProvider`.
The peer range is `>=0.34.6 <1.0.0`, and this package is developed and tested against 0.34.6.
The floor is 0.34.6 because exact interactive attachment needs the host receiver, and workspace branching needs keyed snapshots, durable restores, inventory recovery, and cleanup.
The provider fails closed when the configured backend or its catalog entry cannot be read.
Newer SDKs may also provide `getBackend()` as a lookup over the same catalog.

```ts
import { Sandbox } from "@tangle-network/sandbox";
import { createTangleProvider } from "@tangle-network/agent-provider-tangle";

const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
});
```

## `create()` returns a ready environment

`provider.create()` does not return until the sandbox reports `running`.
This is the contract `AgentEnvironmentProvider.create` states, and every runtime seam relies on it: a caller streams the first turn immediately after create, with nothing in between.
A sandbox that never reaches running fails the create call with the platform's reason, and the adapter deletes the sandbox it could not hand over.

The gap this closes is narrow and specific.
`client.create()` waits by itself only when the create response reports `pending` or `provisioning`.
A response that already reports `running` skips that wait, and `running` alone is not usable: the SDK's own `waitFor` treats the target as reached only when `filesystemIncarnationReadiness` is `ready`, because the sandbox filesystem is still being built until then.
So `create()` can return a sandbox that reports `running` while the platform still holds a lifecycle operation on it, and the first turn lands on that lock.

Composing an environment also reads the sandbox's deployment capability document once, and a sandbox that is not yet running cannot answer that read, so an environment composed during provisioning would claim nothing for the rest of its life.

`readyTimeoutMs` bounds the wait and defaults to `DEFAULT_TANGLE_READY_TIMEOUT_MS` (120 seconds, the Sandbox SDK's own default).

```ts
const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
  readyTimeoutMs: 180_000,
});

const environment = await provider.create({ profile: { name: "worker" } });
for await (const event of environment.stream({ prompt: "run the task" })) {
  // The sandbox is running. No caller-side wait, poll, or retry stands here.
}
```

The platform owns the wait, and this adapter runs no status loop of its own.
It calls `waitFor("running")` on the created instance when the linked SDK offers it, because that refreshes the created instance in place and keeps its create receipt.
It falls back to `client.waitForRunning(id)`, then refreshes the created instance.
A client that offers neither cannot prove readiness, so the sandbox it returned has to report `running` by itself or the create call fails.

The adapter reads the platform's answer back rather than trusting the wait to have resolved for the right reason.
A create call returns only a sandbox that reports `running`: `failed`, `stopped`, and `expired` are refused with the status named, and so is a wait that resolves while the sandbox still reports `provisioning`.

## Per-turn backend options

`AgentTurnInput.providerOptions.backend` reaches `PromptOptions.backend` on the Sandbox prompt call.
This is the exact block agent-runtime emits for a per-turn backend or model override, so a turn can select its model, its inline profile, or a session credential bundle without any change to the environment.

```ts
await environment.stream({
  prompt: "run the task",
  providerOptions: {
    backend: {
      type: "opencode",
      model: {
        provider: "zai",
        model: "glm-5.2",
        authMode: "oauth",
        authFiles: [{ path: ".config/opencode/auth.json", content: seatCredentials, mode: 0o600 }],
      },
    },
  },
});
```

A field the Sandbox prompt options do not declare is refused, in `providerOptions`, in `backend`, and in `backend.model`.
The SDK drops what it does not declare, so a forwarded unknown field would run the turn on different settings with no error anywhere.
The accepted field sets are pinned to the SDK's `BackendConfig` at compile time, at all three levels including `authFiles`, so a field the SDK adds or removes fails this package's build instead of reaching a caller as a wrong refusal.
Values are checked, not just field names: an inline `backend.profile` is read by `agentProfileSchema`, the package that owns profile rules, and `backend.metadata.traceAttributes` is held to the entry and length limits the Sandbox platform states for it.
`AgentTurnInput.interactions` and `backend.interactions` state the same posture, and a disagreement between them is refused rather than resolved by preference.
A turn `model` that disagrees with `backend.model.model` is refused for the same reason.
`AgentTurnInput.interactions` still maps to `backend.interactions` for a turn that carries no backend block at all.

Backend options are part of the retained request digest, so a retry under the same `turnId` with a changed model, profile, or seat conflicts instead of replaying work that ran on other settings.
Bearer material is excluded from that identity: `model.apiKey` is dropped and `authFiles` are reduced to the paths and modes they install.
A rotated seat token is the same seat running the same work, so an ordinary refresh continues its run rather than conflicting with it.

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

| Deployment flag                   | Claims it gates                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `dispatch.runControlRef`          | `streaming.detach`, `streaming.turnIdempotency`, `sessions.continue`, `retainedControl`, `session.cancelRun` |
| `dispatch.executionIdOnAdmission` | `streaming.detach`, `streaming.turnIdempotency`, `sessions.continue`, `retainedControl`, `session.cancelRun` |
| `cancel.canonicalRunCancellation` | `sessions.continue`, `retainedControl`, `session.cancelRun`                                                  |
| `cancel.digestBound`              | `sessions.continue`, `retainedControl`, `session.cancelRun`                                                  |
| `cancel.idempotent`               | `sessions.continue`, `retainedControl`, `session.cancelRun`                                                  |
| `runs.eventReplay`                | `streaming.replay`, `sessions.continue`, `retainedControl`, `session.cancelRun`                              |
| `runs.executionScopedStatus`      | `sessions.continue`, `retainedControl`, `session.cancelRun`                                                  |
| `interactions.responseDedupe`     | `interactions`, `environment.respondToInteraction`, `session.respondToInteraction`                           |

Detached dispatch carries the caller's exact reference and refuses a receipt that does not name the execution back, so it needs both `dispatch` flags and a session handle to reach the run through.
`sessions.continue`, `retainedControl`, and `session.cancelRun` need every flag in the table, because the capability schema refuses a partial retained-control block and each identity rests on its own flag.
A claim takes its operation with it: `streaming.detach` gates `dispatch()`, and `session()` stands while any of `streaming.detach`, `streaming.replay`, or `sessions.continue` stands.
A missing flag means unknown, and unknown is never a claim.

Answering an ask rests on `interactions.responseDedupe` alone, and on nothing retained control needs.
The adapter keeps no record of the responses it sent, so every replay answer comes from the deployment: repeating a command returns the recorded acknowledgement, and a different answer for a recorded ask is refused as `already_resolved_different`.
A deployment that does not record what it acknowledges therefore claims no interactions, even where the local method exists, because an unrecorded response cannot be retried without risking a second answer to a running agent.
The claim and the two methods stand or fall together.

## Answering an interaction

`respondToInteraction` takes the canonical `InteractionResponseCommand` and returns the canonical `InteractionAcknowledgement`.
It is offered on the environment and on a session handle; the environment routes the command to the session its binding names.
The command carries only the answer the caller supplied. No field is filled in on the caller's behalf, and an answer the outstanding ask's spec rejects is refused with the field named.

| Result                                                        | Acknowledgement status                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| The deployment recorded and delivered the response            | `accepted`                                                       |
| The deployment already holds this exact response              | `already_resolved_same`                                          |
| The deployment already holds a different response for the ask | `already_resolved_different`, message naming the recorded digest |
| The command names another provider, environment, or session   | `binding_mismatch`                                               |
| The deployment refuses the binding                            | `binding_mismatch`                                               |
| The ask is unknown to the deployment                          | `unknown_interaction`                                            |
| The session is unknown to the deployment                      | `unknown_run`                                                    |
| The ask left the outstanding set on a deadline                | `expired`                                                        |
| The ask's spec rejects the answer                             | `invalid_response`, message naming each field                    |
| The response is recorded and delivery is unconfirmed          | `transport_failure`, `retryable: true`                           |
| The request did not reach the route                           | `transport_failure`, `retryable: true`                           |

A refusal is never reported as a success, and a recorded response whose delivery the deployment does not confirm is never reported as `accepted`.

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

### Workspace branching

`environment.workspaceBranching` is the single operation surface for creating
and recovering a checkpoint, forking one managed child, and cleaning both
resources in dependency order.
The adapter advertises `branching.checkpoint`, `branching.fork`, `retrySafe`,
`lookup`, and `cleanup` only when the linked SDK exposes the complete managed
surface: keyed `snapshot`, durable snapshot restore, inventory recovery, and
explicit deletion outcomes.
An incomplete SDK surface clears every branching flag and omits
`environment.workspaceBranching`.

Every operation validates the canonical agent-interface request digest before
calling Sandbox.
Retries with the same key replay the original resource, while changed material
returns a conflict containing the original interface digest.
The provider stores a bounded request marker in snapshot tags and child
metadata so a fresh process can recover the exact interface digest.
Snapshot-created children are validated through the marker and complete
account inventory, while legacy fork markers also require the Sandbox fork
ledger to report a settled success.
Checkpoint deletion reports `in_use` with every verified child that still
references it; delete the child first, then retry checkpoint deletion.
The adapter never treats an SDK response without an explicit idempotency or
deletion outcome as success.

After a provider process restart, `provider.workspaceBranching.forEnvironment()`
returns a fresh source-scoped handle for lookup and cleanup, or `null` when it
cannot prove the complete operation surface.

Recovery reads the account inventory through Sandbox offset pages of at most
1,000 sandboxes and continues until a short page proves the inventory is
complete.
The adapter also reads checkpoints from the previous marker format while writing only the current bounded format.
Malformed, repeated, failed, or over-bound pages return `unknown` and do not
mutate a resource.
Sandbox exposes snapshots only through the live source instance.
If that source was deleted, this provider cannot recover its checkpoints or
forked children through the public SDK.
Clean branch resources before deleting the source or use a platform reaper.

```ts
import {
  workspaceCheckpointRequestDigest,
  workspaceForkRequestDigest,
} from "@tangle-network/agent-interface";

const checkpoint = await environment.workspaceBranching?.checkpoint({
  source: exactRun,
  idempotencyKey: "checkpoint-before-analysis",
  requestDigest: workspaceCheckpointRequestDigest({ source: exactRun }),
});

if (checkpoint?.status === "created" || checkpoint?.status === "replayed") {
  const fork = await environment.workspaceBranching?.fork({
    checkpoint: checkpoint.checkpoint,
    placement: { kind: "sandbox", sandboxId: "analysis-worker" },
    idempotencyKey: "analysis-worker",
    requestDigest: workspaceForkRequestDigest({
      checkpoint: checkpoint.checkpoint,
      placement: { kind: "sandbox", sandboxId: "analysis-worker" },
    }),
  });
}
```

### Confidential forks

Sandbox returns raw TEE evidence, not a verified claim.
The deployed Tangle job does not carry snapshot restore or sealed-persistence inputs.
The provider therefore refuses new confidential workspace forks before creation.
Existing confidential fork records still require a matching TEE report and an external verifier before they become trusted.
Pass `confidentialAttestationVerifier` to `createTangleProvider` to connect a
trusted provider-key and measurement verifier.
The callback receives the raw report, the expected environment binding, and
the canonical request-bound attestation material.
It returns a provider key id, signature, and optional normalized measurement
only after verification succeeds.
Returning `null`, throwing, a mismatched measurement, or a copied quote leaves
the result unverified while preserving `confidentialRequested: true`.
The same unverified result occurs when no trusted verifier is configured.
The adapter does not trust the requested nonce, child metadata, or any legacy
`confidential: true` assertion as proof.
`verifyTangleQuote` below represents a verifier supplied by the caller.

```ts
const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
  confidentialAttestationVerifier: async ({ report, attestation }) =>
    (await verifyTangleQuote({ report, attestation })) ?? null,
});
```

The provider stores the raw report in `ConfidentialAttestation.quote` through
`encodeTangleConfidentialAttestationQuote`.
The quote is a versioned canonical JSON object with base64url byte fields.
Use `decodeTangleConfidentialAttestationQuote` to recover a report and reject
legacy numeric-array quotes, unknown fields, malformed bytes, and oversized
reports before verification.

## Environment observation

`environment.observe()` returns the normalized `AgentEnvironmentObservation`.
Every surface carries a freshness discriminator, so a value the Sandbox SDK does not report is visibly absent instead of arriving as a measured zero.
The `observation` capability flag for a surface is true only when a source can put a value on it for that environment; the observation itself always carries the surface, with `unavailable` and its reason when there is nothing to report.

| Surface                        | Sandbox source                                             | State when the source is missing        |
| ------------------------------ | ---------------------------------------------------------- | --------------------------------------- |
| `identity`                     | provider name and `box.id`                                 | always known                            |
| `lifecycle.status`             | `box.status` after a refresh                               | `stale` with the refresh failure        |
| `lifecycle.cleanup`            | `box.expiresAt` as a scheduled retirement                  | omitted from the lifecycle value        |
| `endpoint`                     | scheme, host, and explicit port of `connection.runtimeUrl` | `unavailable`                           |
| `placement.verified`           | `client.describePlacement(box)`                            | `unavailable`                           |
| `resources.requested`          | the `create()` resource request                            | omitted on an environment rebuilt by id |
| `resources.effective`          | cgroup `memoryLimitMb` and the attached GPU lease          | `unavailable`                           |
| `resourceUse.current` / `peak` | cgroup `memoryCurrentMb` / `memoryPeakMb`                  | `unavailable`                           |
| `modelUsage`                   | the newest execution this handle measured                  | `unavailable`                           |
| `computeBilling`               | the GPU lease's billed or estimated customer cost          | `unavailable`                           |
| `accountUsage`                 | `client.subscription()` and `client.usage()`               | `unavailable`                           |

Four quantities have no Sandbox source at all, and the adapter reports them as absent rather than deriving them.
There is no effective CPU or disk figure anywhere in the SDK, so `resources.effective` carries memory and the accelerator only.
The cgroup reports cumulative CPU microseconds, which is not a utilization figure, so `resourceUse` carries memory only rather than a rate computed from one sample.
Sandbox prices an attached GPU lease and publishes no per-sandbox container compute cost, so `computeBilling` is unavailable on an environment with no lease.
`lifecycle.continuity` and `lifecycle.persistence` have no readable source and are omitted.

Two account values are reported as absent on purpose.
A negative credit balance under an overage plan cannot be stated as non-negative remaining credit, and an account with no concurrent-sandbox ceiling has no quota to state; reporting either as zero would hide a debt or invent a limit.

`resources.requested` is the request the adapter sends, not the request the caller typed.
The contract states CPU, memory, and disk as `cpu`/`memoryMb`/`diskMb` while Sandbox reads `cpuCores`/`memoryMB`/`diskGB`, so the adapter translates them; a disk size that is not a whole number of gibibytes is refused rather than rounded.
A `resources.gpu` class becomes one accelerator device, which is the Sandbox default device count for a request that names only its class.

The observation makes two calls of its own — the account subscription and usage counters — plus the cgroup sample and a refresh.
A hop that fails does not fail the observation: its surface carries the transport's own message as the reason, and a value the refresh could not renew is reported as `stale` rather than as current.

Nothing in the observation can carry a credential.
The endpoint holds only a scheme, a host, and an explicit port; userinfo, path, and query are dropped, and the bearer beside the runtime URL is never read.

## Interactive terminal

`environment.attachTerminal(request)` opens or reattaches one PTY over the sandbox terminal WebSocket, and `environment.terminal(id)` returns the live handle.
The four `interactiveTerminal` flags rest on one fact — the sandbox serves the PTY socket and reports terminal metadata — because all four operations reach the caller through one socket from one linked SDK.

Attach uses the request's `connectionId`, else its `terminalSessionId`, else a generated id; reusing an id reattaches the PTY and replays its retained screen, which the runtime reports as `reattached`.
`mode: "logical"` is refused: Sandbox resumes a terminal only by attaching it, and serving an attach the caller did not ask for would start a PTY behind their back.

`events()` replays retained frames from an EXCLUSIVE `since` cursor and then continues until the terminal exits.
Only `output` frames carry a sequence; `ready`, `resize`, `error`, and `exit` keep their place in the same ordered log.
A cursor the retained buffer no longer holds is refused, because resuming after the gap would drop output the consumer believes it received.

Every reference states an expiry one detach window past the newest activity the adapter can prove, and `input` and `resize` refuse a reference that is expired or no longer running.
`attachCount` counts the attaches this environment holds, not the runtime's own viewers.
`close()` reports `closed` only when the socket delivered an exit; Sandbox exposes no terminal delete, so an unproven close reports `unknown` rather than claiming a termination that did not happen.
An attach whose runtime metadata lacks a name, shell, working directory, geometry, timestamps, running state, or detach window fails closed with `unknown`, because a reference cannot state facts the runtime did not report.

Pass `exactProcess: {}` only when the Sandbox deployment supports `agent: false` creates and reports `metadata.runtimeMode: "control"`.
The optional capability creates an ephemeral sandbox with an authenticated control service but no managed agent workload or agent credentials, explicit resources, exact blocked/domain egress, bounded binary file reads, shell-free launch, and recoverable process output plus terminal reason.
Set `teamId` inside `exactProcess` to scope create, lookup, and recovery to one team.

```ts
const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
  exactProcess: {},
});

const environment = await provider.exactProcess!.create({
  image: "ghcr.io/acme/agent@sha256:<64-hex-manifest-digest>",
  egress: { mode: "blocked" },
  maxLifetimeMs: 120_000,
  resources: { cpu: 1, memoryMb: 1024, diskMb: 1024 },
  metadata: { executionId: "run-1" },
  idempotencyKey: "run-1",
});
```

The adapter rejects ordinary sandboxes during create, recovery, and list operations.
