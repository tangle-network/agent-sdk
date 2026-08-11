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

The bridge model is selected from run data in this order: the turn, the provider default, or the profile's `harness` plus `model.default`.
Execution fails before network use when none is present.

Passing the same `sessionId` on later turns continues the same CLI conversation.
`executionId` gives a turn stable bridge identity, and `lastEventId` reattaches after a reader failure.
`dispatch()` starts a bridge-owned durable run and returns after detaching its HTTP reader.
The returned `AgentSession` exposes status, cursor-based event replay, the terminal result, continuation, and cancellation.
Cancellation returns only after cli-bridge confirms the run is terminal.
Usage events and terminal result metadata include `modelRequests` only when the bridge measured an exact non-negative integer count.
Missing, malformed, partial, or estimated request counts remain unknown.
When `dispatch()` receives no `sessionId`, it creates one from that turn's stable run id and returns it.
Replay and result reads fail loudly after cli-bridge's configured replay retention expires.
Stopping a `session.events()` reader detaches only that replay observer.
Stopping a direct `environment.stream()` reader or destroying the environment cancels its active bridge runs and waits for terminal confirmation.

Response headers and streamed bodies have no transport timeout by default.
For unattended runs, set `headersTimeoutMs`, `bodyTimeoutMs`, or an `AbortSignal` so an unresponsive bridge cannot wait forever.
