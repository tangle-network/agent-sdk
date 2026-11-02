# @tangle-network/agent-provider-daytona

`AgentEnvironmentProvider` for Daytona: each environment is a Daytona sandbox created from the CLI Bridge box snapshot, and every turn runs through `@tangle-network/agent-provider-cli-bridge/sandbox`.
A profile that runs on Tangle runs here unchanged: the harness comes from `profile.harness`, the model goes through the Tangle Router on the key you pass, and `workspace.repoUrl` is cloned before `create` returns.

```ts
import { createDaytonaProvider } from '@tangle-network/agent-provider-daytona'
import { providerAsSandboxClient } from '@tangle-network/agent-runtime'

const provider = createDaytonaProvider({ router: { key: process.env.TANGLE_API_KEY! } })
const client = providerAsSandboxClient(provider, { defaults: { profile } })
```

`apiKey`, `apiUrl` and `target` default to the Daytona SDK's reading of `DAYTONA_API_KEY`, `DAYTONA_API_URL` and `DAYTONA_TARGET`.

## The box snapshot

Build it once per CLI Bridge pin from the repository root:

```sh
DAYTONA_API_KEY=... pnpm build:sandbox-image --target daytona
```

The script prints `DAYTONA_SNAPSHOT=<name>`; that name is `BOX_TEMPLATE_NAME` from `@tangle-network/agent-provider-cli-bridge/sandbox`, the default.
Pass `snapshot` to use another build, or `workspace.environment` on one create.

## What a create honors

| Field | Daytona |
| --- | --- |
| `profile`, `backend` | the Bridge in the box materializes the profile for the selected harness |
| `workspace.repoUrl`, `gitRef`, `cwd` (repository base) | cloned and resolved under `/home/node/workspace` |
| `workspace.environment` | the snapshot name |
| `env`, `metadata`, `name` | `envVars`, `labels`, `name` |
| `egress` | `open`; `strict` as `domainAllowList` plus the Router host; `blocked` as `networkBlockAll` |
| `signal` | an abort settles `create` at once; a sandbox that arrives later is deleted |

Every other field (`workspace.image`, `resources`, `secrets`, `idempotencyKey`, snapshots, checkpoints, provider options and the rest) is refused with an `EnvironmentProviderError` that names it, before any Daytona call.
Each sandbox carries the run tag label and a `ttlMinutes` lifetime; it is private, its port is reached with the preview token, and a stopped sandbox is deleted at once.

## Proof

`pnpm --filter @tangle-network/agent-provider-daytona test:live` runs `runLiveProfileConformance` from `@tangle-network/agent-provider-testkit`.
Without `DAYTONA_API_KEY` and `TANGLE_API_KEY` it reports `no credential: <NAME>` and proves nothing.
