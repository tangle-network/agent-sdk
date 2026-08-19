# @tangle-network/agent-provider-cli-bridge

Wraps a running `cli-bridge` server as an `AgentEnvironmentProvider`.

```ts
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'

const provider = createCliBridgeProvider({
  baseUrl: 'http://127.0.0.1:8787',
  bearerToken: process.env.CLI_BRIDGE_TOKEN,
})

const environment = await provider.create({
  profile: {
    name: 'researcher',
    harness: 'codex',
    model: { default: 'gpt-5' },
  },
})

const reference = await environment.dispatch({
  prompt: 'inspect the repository',
  sessionId: 'research-session',
  executionId: 'research-turn-1',
})
await saveControlRef(reference.controlRef)
const session = environment.session(reference.id)

for await (const event of session.events({ since: '0' })) {
  // Sequence-numbered bridge events, including normalized usage and result data.
}

await session.prompt({
  prompt: 'change direction using the evidence already collected',
  executionId: 'research-turn-2',
})
```

Persist the returned `controlRef` before treating dispatch as accepted.
It contains the exact provider, environment, session, execution, run, and request digest needed after a process restart.
Reconstruct the environment with `provider.get(controlRef.environmentId)`, then call `environment.session(controlRef.sessionId, { controlRef })`.
The provider rejects any coordinate or digest mismatch instead of attaching to a different run.
If the caller crashes before saving `controlRef`, call `provider.lookupRun()` with the planned run coordinates.
The lookup returns the server-issued digest only when all five planned coordinates match the retained run.

The bridge model is selected from run data in this order: the turn, the provider default, or the profile's `harness` plus `model.default`.
Execution fails before network use when none is present.

Passing the same `sessionId` on later turns continues the same CLI conversation.
`executionId` gives a turn stable bridge identity, and `lastEventId` reattaches after a reader failure.
`dispatch()` starts a bridge-owned durable run and returns after detaching its HTTP reader.
The returned `AgentSession` exposes status, cursor-based event replay, the terminal result, continuation, and cancellation.
Cancellation returns only after cli-bridge confirms the run is terminal.
A direct stream treats a finish frame as provisional until cli-bridge returns the same run's aggregate result.
A retained replay confirms its terminal state from the retained run endpoint.
Retained native runs use canonical runtime envelopes and finish with a terminal status event.
Pass any emitted event `id` back as `since` to resume after that event.
The canonical envelope identity remains available as `event.data.eventId`.
Legacy runs keep the OpenAI chunk format and its `[DONE]` marker.
The provider uses the explicit SSE event field to select the format and rejects mixed streams.
The provider rejects a terminal response when its run id or request digest does not match the accepted stream.
Usage events and terminal result metadata include `modelRequests` only when the bridge measured an exact non-negative integer count.
Missing, malformed, partial, or estimated request counts remain unknown.
When `dispatch()` receives no `sessionId`, it creates one from that turn's stable run id and returns it.
Replay and result reads fail loudly after cli-bridge's configured replay retention expires.
Stopping a `session.events()` reader detaches only that replay observer.
Stopping a direct `environment.stream()` reader or destroying the environment cancels its active bridge runs and waits for terminal confirmation.

Pi retained sessions also expose typed permission interactions.
The provider stores the selected harness, exact model route, and canonical create digest inside its opaque environment identifier.
This identifier lets `provider.get()` reconstruct profile-selected routes after process death without a cache or repeated configuration.
The create digest prevents an altered profile or workspace from reusing the previous retained identity.
`provider.get()` accepts only identifiers created by this provider and rejects plain caller identifiers.
The provider queries `/v1/capabilities` for each retained route restored through `provider.get()`.
`provider.capabilities()` queries the configured default route before the Runtime selects retained execution.
The provider shares concurrent discovery requests and refreshes every later query.
It enables retained control only when the running Bridge proves the complete contract.
It enables native interactions only when the running Bridge proves the Pi contract.
Every native turn stays on the model route used for that discovery; another model requires another environment.
An explicit capability document remains available for a caller that already performed the same discovery.
That capability selects cli-bridge's native `/v1/sessions` and `/turns` transport; it never sends an interactive turn to `/v1/chat/completions`.
The environment and session then expose `respondToInteraction()` for exact response commands.
Each command carries its run, session, execution, request digest, and stable operation identifier.
Native turns require caller-stable `turnId` and `executionId` values so an ambiguous admission cannot create another run.
The bridge records repeated operations and rejects a different answer for an existing operation.
The provider reports an unconfirmed network result as retryable and never reports it as accepted.
Native replay reads `/v1/runs/:runId/events` and validates each canonical envelope through Agent Interface before exposing it.
When a turn supplies `interactions`, the provider carries its exact map, including an explicit `{}`; an omitted map remains omitted.
Every requested key must be advertised by the selected environment, including keys set to `false`; an unsupported key fails before transport use.
One-shot requests keep this posture as a top-level `interactions` field rather than moving it into `metadata`.
The cli-bridge turn schema must accept that top-level field and include it in its request digest.
Other runners stay disabled until cli-bridge proves the same replay and response behavior for them.

To run the real cross-repository contract, point the test at an installed cli-bridge source checkout:

```sh
CLI_BRIDGE_INTEGRATION_ROOT=/path/to/cli-bridge pnpm test -- tests/cli-bridge.integration.test.ts
```

Use `pnpm test:integration` for the fail-closed form of this command.
It exits before Vitest when `CLI_BRIDGE_INTEGRATION_ROOT` is missing.
The regular `pnpm test` command remains portable and skips this cross-repository test when no checkout is configured.

The test launches the actual Bridge server and a jailed Pi RPC process.
It proves dispatch, permission response, completion, reconnect, replay, and idempotent response retry.
CI runs this test in a separate job against a pinned Bridge checkout, rebuilds its native SQLite binding, and fails if the checkout cannot build or the integration test is skipped.

Response headers and streamed bodies have no transport timeout by default.
For unattended runs, set `headersTimeoutMs`, `bodyTimeoutMs`, or an `AbortSignal` so an unresponsive bridge cannot wait forever.

## Environment observation

`environment.observe()` returns the normalized `AgentEnvironmentObservation` when the provider document carries an `observation` block.
Every surface keeps a freshness discriminator, so a value this bridge cannot report is visibly absent instead of arriving as a measured zero.

| Surface | cli-bridge source | State when the source is missing |
| --- | --- | --- |
| `identity` | provider name and environment id | always known |
| `lifecycle.status` | `running` until the environment is destroyed | always known |
| `endpoint` | scheme, host, and explicit port of `baseUrl` | `unavailable` |
| `placement.verified` | `defaultExecution.kind` as `sandbox` or `local` | always known |
| `modelUsage` | the token usage and cost the newest execution measured | `unavailable` |

cli-bridge forwards a turn and provisions no compute, so it states no requested or effective compute shape, no resource use, and no compute cost.
It holds no account, so it states no plan, credit balance, quota, or billing period.
Those five surfaces are never claimed in the capability document and always carry `unavailable` with the reason.

The usage of one run is summed across its events and attributed to that run's execution id, which the observation carries as the provenance source.
An environment rebuilt with `provider.get(id)` has measured nothing yet, so it reports the usage surface as unavailable until a turn completes through it.
The endpoint holds only a scheme, a host, and an explicit port; userinfo, path, and query are dropped, and the bearer beside the base URL is never read.
