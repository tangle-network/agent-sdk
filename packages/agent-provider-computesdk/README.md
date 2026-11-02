# @tangle-network/agent-provider-computesdk

An `AgentEnvironmentProvider` whose environments are sandboxes on any [computesdk](https://www.npmjs.com/package/computesdk) backing provider, each running CLI Bridge from the box image.
Turns, profile materialization, refusals, usage and cancellation come from `createBridgeSandboxProvider` in `@tangle-network/agent-provider-cli-bridge/sandbox`; this package is the computesdk vendor.

```ts
import { compute } from 'computesdk'
import { e2b } from '@computesdk/e2b'
import { createComputeSdkProvider } from '@tangle-network/agent-provider-computesdk'

compute.setConfig({ provider: e2b({ apiKey: process.env.E2B_API_KEY }) })
const provider = createComputeSdkProvider({ compute, router: { key: perRunRouterKey } })
```

The sandbox boots `template` (default: the box template `pnpm build:sandbox-image --target e2b` publishes) with the provider's finite lifetime and the run tag.
`workspace.environment` selects another template or snapshot id. `workspace.image`, `resources` and `egress` are refused, because each backing provider reads them differently.

computesdk 4.1 limits what the adapter can prove on every backing provider:

- `getById` answers `null` for any failure, so a transport or auth error reads as an absent sandbox in `get` and `status`.
- `list` returns no tags, so `list` reconnects to every sandbox computesdk lists and reads the tags each one carries in `TANGLE_BRIDGE_TAGS`; the e2b backing provider lists its first page only.
- `destroy` swallows failures, so the adapter looks the sandbox up again and throws `cleanup_failed` while it is still present.

`tests/computesdk-live.integration.test.ts` runs the live profile conformance suite on the e2b backing provider (`E2B_API_KEY`) and on the local docker backing provider (`CLI_BRIDGE_BOX_IMAGE` from `pnpm build:sandbox-image --target docker`), both with a per-run capped `TANGLE_API_KEY`.
