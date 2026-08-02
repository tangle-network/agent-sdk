# @tangle-network/agent-provider-cli-bridge

Wraps a running `cli-bridge` server as an `AgentEnvironmentProvider`.

```ts
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'

const provider = createCliBridgeProvider({
  baseUrl: 'http://127.0.0.1:8787',
  bearerToken: process.env.CLI_BRIDGE_TOKEN,
  defaultModel: 'openai-codex/gpt-5',
})

const environment = await provider.create({
  profile: {
    name: 'researcher',
    harness: 'codex',
    model: { default: 'gpt-5' },
  },
})
```

The bridge model is selected from run data in this order: the turn, the provider default, or the profile's `harness` plus `model.default`.
Execution fails before network use when none is present.
Set `defaultModel` to enable retained sessions; capability discovery and retained creation are both bound to that exact runner and model.

When the selected backend returns retained-session capabilities, the provider creates one `/v1/sessions` resource and exposes `dispatch`, `session`, live events, replay, result, prompt, status, usage, interaction responses, and a reconnectable `controlRef`.
Retained event streams are parsed as canonical `RuntimeEventEnvelope` values from `@tangle-network/agent-interface`.
The returned profile materialization receipt is frozen and must remain unchanged for the lifetime of the provider session.
The provider compares the server's exact create digest before recovering a lost create response, and every retained run reference carries the server's run-admission digest after it is observed.
Retained turns require a stable caller `executionId` or `turnId`; the provider preserves that public id while deriving a separate session-scoped wire run id.
Create-level environment variables, secrets, resource limits, provider options, repository workspaces, and provider execution settings remain on the one-shot path because the retained create route cannot represent them exactly.

Closing an event iterator or aborting its reader detaches the retained run.
Destroying an environment created by this provider cancels any active owned run and closes its retained server session; destroying a read-only reconstruction only detaches and closes the local transport.
`AgentSession.cancelRun(request)` sends a digest-bound cancellation for one exact run and returns the bridge's known effect or an honest unknown result.
The compatibility `AgentSession.cancel()` method also sends `/cancel`, but does not provide a retry acknowledgement to its caller.
Use the interaction command binding returned by the retained run unchanged so the bridge can return its exact idempotency acknowledgement.

Backends that return no retained capability, or legacy bridges that do not expose `/v1/sessions`, continue through `/v1/chat/completions`.
That compatibility path keeps its existing one-shot cancellation behavior and does not expose retained-session operations.

`provider.get("cli-bridge")` reconstructs the bridge environment after the original provider object is gone; call `environment.session(sessionId, { controlRef })` with the saved reference.
If the bridge reports `unknown`, the provider preserves that state instead of converting it to success or cancellation.

Response headers and streamed bodies have no transport timeout by default.
For unattended runs, set `headersTimeoutMs`, `bodyTimeoutMs`, or an `AbortSignal` so an unresponsive bridge cannot wait forever.

The package includes deterministic retained HTTP contract tests.
Set `CLI_BRIDGE_LIVE_URL` (and optionally `CLI_BRIDGE_LIVE_TOKEN`) to run the no-turn contract check against a real bridge.
Set `CLI_BRIDGE_LIVE_TURN=1` and `CLI_BRIDGE_LIVE_MODEL` to run one complete retained turn through the provider and installed Pi subscription.
