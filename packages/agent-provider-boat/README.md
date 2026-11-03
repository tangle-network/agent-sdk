# @tangle-network/agent-provider-boat

`AgentEnvironmentProvider` for [Boat](https://boat.dev): each environment is a Boat sandbox running CLI Bridge, and every turn runs through `@tangle-network/agent-provider-cli-bridge/sandbox`.

> **Experimental — offline-typed, not yet live-verified.** The adapter is written against `@boatdev/sdk` 1.13 but no live conformance run has proven the create/spawn/endpoint paths against boat.dev. The protected hosted-port header scheme in particular is an assumption the live run must confirm. Treat every capability as unproven until `BOAT_API_KEY` live tests land.

```ts
import { createBoatProvider } from '@tangle-network/agent-provider-boat'

const provider = createBoatProvider({
  apiKey: process.env.BOAT_API_KEY,          // defaults to the SDK's reading of BOAT_API_KEY
  router: { key: perRunRouterKey },
})
```

## The box on Boat

Boat exposes no custom images, so a fresh create runs Boat's `setupScript` to install the exact pins the box image carries (`boatBridgeSetupScript()`), then starts CLI Bridge from the hosted Bridge port. Booting a prepared snapshot — `from` at construction, or `workspace.environment` on one create, or a `fork()` — skips that install; prepare one by creating a sandbox, letting the setup run, and saving a named snapshot.

## What a create honors

| Field | Boat |
| --- | --- |
| `profile`, `backend` | the Bridge in the sandbox materializes the profile for the selected harness |
| `workspace.repoUrl`, `gitRef`, `cwd` (repository base) | cloned and resolved under the workspace |
| `workspace.environment` | a Boat snapshot name or sandbox id, passed as `from` |
| `env`, `metadata`, `name` | sandbox `env`, `labels`, `name` |
| `signal` | an abort settles `create` at once; a sandbox that arrives later is deleted |

Every other field (`workspace.image`, `resources`, `egress`, `secrets`, provider options and the rest) is refused with an `EnvironmentProviderError` that names it, before any Boat call. Boat sandboxes carry the run tag as a label and a `ttlSeconds` lifetime.

## Checkpoints

Every environment exposes `checkpoint()` and `fork(ref)`: a checkpoint saves a named Boat snapshot (`tangle-ckpt-…` unless you pass `name`), and `fork` creates a new sandbox from it through `create({ from })`.
