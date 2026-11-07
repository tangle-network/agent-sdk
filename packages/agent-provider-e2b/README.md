# @tangle-network/agent-provider-e2b

`AgentEnvironmentProvider` for E2B: each environment is an E2B sandbox created from the CLI Bridge box template, and every turn runs through the Bridge in that sandbox.

Profile validation, refusals, harness pinning, turns and teardown come from `@tangle-network/agent-provider-cli-bridge/sandbox`; this package is the E2B vendor under it.

## Install

```bash
pnpm add @tangle-network/agent-provider-e2b @tangle-network/agent-runtime
```

## Quickstart

```ts
import { createE2BProvider } from "@tangle-network/agent-provider-e2b";
import { providerAsSandboxClient, runAgentRounds } from "@tangle-network/agent-runtime/kernel";
import type { AgentProfile } from "@tangle-network/agent-interface";

const provider = createE2BProvider({
  apiKey: process.env.E2B_API_KEY,       // defaults to E2B_API_KEY
  router: { key: process.env.TANGLE_API_KEY! },  // model calls route through Tangle Router
});

const client = providerAsSandboxClient(provider);

const profile = {
  name: "my-agent",
  harness: "claude-code",
  model: { provider: "anthropic", default: "anthropic/claude-sonnet-4-6" },
} satisfies AgentProfile;

const result = await runAgentRounds({
  task: "Fix the failing test in src/utils.ts",
  driver: {
    plan: async (task, history) => (history.length === 0 ? [task] : []),
    decide: () => "done" as const,
  },
  agentRun: { profile, taskToPrompt: (t) => t },
  output: { parse: (events) => events },
  ctx: { sandboxClient: client },
});
```

## The box template

E2B sandboxes boot from a pre-built template that includes the CLI Bridge and every supported harness. Build it once per CLI Bridge pin:

```bash
pnpm build:sandbox-image --target e2b
```

This publishes the template to your E2B account. The template name defaults to `BOX_TEMPLATE_NAME` from `@tangle-network/agent-provider-cli-bridge/sandbox`.

Pass `template` to the provider constructor to use a specific build, or `workspace.environment` on individual creates.

## What a create honors

| Field | E2B |
|---|---|
| `profile`, `backend` | The Bridge in the box materializes the profile for the selected harness |
| `workspace.repoUrl`, `gitRef`, `cwd` | Cloned and resolved inside the sandbox |
| `workspace.environment` | Selects a different template by name |
| `env`, `metadata`, `name` | Sandbox env vars, metadata, and name |
| `signal` | An abort settles `create` at once; a sandbox that arrives later is deleted |

Every other field is refused with an `EnvironmentProviderError` that names it, **before any E2B call**:

| Refused field | Why |
|---|---|
| `workspace.image` | E2B uses templates, not custom images |
| `resources` | Fixed by the template build |
| `egress` (all modes) | E2B does not expose egress controls |
| `secrets` | Not supported on E2B |
| `idempotencyKey` | Not supported on E2B |
| Snapshots and checkpoints | Not supported on E2B |

## Sandbox lifecycle

Each sandbox has a finite lifetime (`lifetimeMs`) and carries the run tag in its metadata. The provider:

- Sets a default lifetime if none is provided
- Tags every sandbox with the run identifier for filtering
- Cleans up on teardown
- Lists sandboxes by filtering on metadata and name

## Model inference

The `router.key` option routes all model calls through the Tangle Router. This means:

- The same `AgentProfile` works on Tangle and E2B unchanged
- Spend caps and budget holds apply
- BYOK keys pass through to the provider

Without `router.key`, model calls go directly to the provider using whatever credentials the profile carries.

## Conformance

```bash
pnpm --filter @tangle-network/agent-provider-e2b test
```

Runs `runLiveProfileConformance` against E2B — the full 67-check conformance suite. Without `E2B_API_KEY` it reports `no credential: E2B_API_KEY` and proves nothing.

## Comparison with other providers

| Capability | Tangle | E2B | Daytona | Boat |
|---|---|---|---|---|
| Checkpoints & snapshots | ✅ | ❌ | ✅ | ✅ |
| Egress allowlists | ✅ | ❌ | ✅ | ❌ |
| Custom images | ✅ | ❌ | ❌ | ❌ |
| Secrets | ✅ | ❌ | ❌ | ❌ |
| Durable resume | ✅ | ❌ | ❌ | ❌ |

See [the multi-provider docs](https://docs.tangle.tools/sandbox/other-providers) for the full comparison.

## License

MIT
