# @tangle-network/agent-provider-e2b

`AgentEnvironmentProvider` for E2B: each environment is an E2B sandbox created from the CLI Bridge box template, and every turn runs through the Bridge in that sandbox.
Profile validation, refusals, harness pinning, turns and teardown come from `@tangle-network/agent-provider-cli-bridge/sandbox`; this package is the E2B vendor under it.

```ts
import { createE2BProvider } from '@tangle-network/agent-provider-e2b'

const provider = createE2BProvider({ router: { key: process.env.TANGLE_API_KEY! } })
```

- `apiKey` defaults to `E2B_API_KEY`.
- `template` defaults to the box template that `pnpm build:sandbox-image --target e2b` publishes for the pinned CLI Bridge commit; `workspace.environment` selects another template per create.
- Each sandbox has a finite lifetime (`lifetimeMs`) and carries the run tag in its metadata; `list` filters on metadata and `name`.
- Refused before any E2B call: `workspace.image`, `resources` (fixed by the template build), every `egress` mode, keyed create, secrets, snapshots and checkpoints.

Proof: `pnpm --filter @tangle-network/agent-provider-e2b test` runs `runLiveProfileConformance` against E2B; without `E2B_API_KEY` it reports `no credential: E2B_API_KEY`.
