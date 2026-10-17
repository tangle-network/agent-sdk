# agent-sdk

Shared TypeScript contracts, core transport primitives, and provider adapters
for Tangle's agent stack. Use this workspace when implementing a provider or
building against the shared agent contract—not as a second agent runtime.

## Choose the right entry point

- **Create and control Tangle sandboxes:** start with the
  [`@tangle-network/sandbox` SDK](https://docs.tangle.tools/).
- **Run agents or write a coordinator:** start with
  [`agent-runtime`](https://github.com/tangle-network/agent-runtime).
- **Implement an integration against shared types or an environment provider:**
  use the packages below.

The first useful result here is a consumer talking to its chosen provider
through the declared contract, without copying schemas or depending on a
provider's private implementation. The application keeps its task and policy;
this workspace supplies the shared boundary.

| Package | Description |
| --- | --- |
| [`@tangle-network/agent-interface`](packages/agent-interface) | Shared TypeScript types and zod schemas defining the agent/provider contract. Zero runtime beyond zod. |
| [`@tangle-network/agent-core`](packages/agent-core) | Runtime primitives for talking to Tangle agents: auth token issue/verify, SSE stream parsing, transport interfaces, retries/resilience, and telemetry. Depends on `@tangle-network/agent-interface`. |
| [`@tangle-network/agent-provider-testkit`](packages/agent-provider-testkit) | Conformance checks that any `AgentEnvironmentProvider` package can run before publishing. |
| [`@tangle-network/agent-provider-tangle`](packages/agent-provider-tangle) | Adapter from Tangle sandbox clients into the shared environment provider contract. |
| [`@tangle-network/agent-provider-cli-bridge`](packages/agent-provider-cli-bridge) | Adapter for a CLI bridge OpenAI-compatible HTTP endpoint. |
| [`@tangle-network/agent-provider-computesdk`](packages/agent-provider-computesdk) | Adapter for ComputeSDK-backed sandboxes. |
| [`@tangle-network/agent-provider-e2b`](packages/agent-provider-e2b) | Direct E2B adapter. |
| [`@tangle-network/agent-provider-daytona`](packages/agent-provider-daytona) | Direct Daytona adapter. |

## What compatibility means

Use the provider testkit and the package's declared support to establish the
contract a consumer can rely on. Shared schemas do not imply that all providers
have the same capabilities, run in every JavaScript environment, or can resume
each other's suspended harness state. Report unsupported operations explicitly.
A conformance result is not a production reliability benchmark.

This README owns the repository's purpose and entry paths. Package docs own
implementation details; [#514](https://github.com/tangle-network/agent-sdk/issues/514)
tracks remaining adoption and documentation checks. Keep those checks out of a
second vision document.

## Install

```bash
pnpm add @tangle-network/agent-core @tangle-network/agent-interface
pnpm add @tangle-network/agent-provider-tangle
```

`@tangle-network/agent-core` uses `node:crypto` for token signing/verification,
so it requires Node.js >= 18 in any environment that exercises those paths.

## Development

```bash
pnpm install
pnpm build         # build all packages
pnpm check-types   # typecheck all packages
pnpm test          # run package test suites
```

## License

MIT
