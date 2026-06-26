# agent-sdk

Public home of the TypeScript SDK for building against Tangle agents. This is a
pnpm workspace containing the shared contracts, core client, and provider
adapters:

| Package | Description |
| --- | --- |
| [`@tangle-network/agent-interface`](packages/agent-interface) | Shared TypeScript types and zod schemas defining the agent/provider contract. Zero runtime beyond zod. |
| [`@tangle-network/agent-core`](packages/agent-core) | Runtime primitives for talking to Tangle agents: auth token issue/verify, SSE stream parsing, transport interfaces, retries/resilience, and telemetry. Depends on `@tangle-network/agent-interface`. |
| [`@tangle-network/agent-provider-testkit`](packages/agent-provider-testkit) | Conformance checks that any `AgentEnvironmentProvider` package can run before publishing. |
| [`@tangle-network/agent-provider-sandbox`](packages/agent-provider-sandbox) | Adapter from `@tangle-network/sandbox` clients into the shared environment provider contract. |
| [`@tangle-network/agent-provider-cli-bridge`](packages/agent-provider-cli-bridge) | Adapter for a CLI bridge OpenAI-compatible HTTP endpoint. |
| [`@tangle-network/agent-provider-computesdk`](packages/agent-provider-computesdk) | Adapter for ComputeSDK-backed sandboxes. |
| [`@tangle-network/agent-provider-e2b`](packages/agent-provider-e2b) | Direct E2B adapter. |
| [`@tangle-network/agent-provider-daytona`](packages/agent-provider-daytona) | Direct Daytona adapter. |

## Install

```bash
pnpm add @tangle-network/agent-core @tangle-network/agent-interface
pnpm add @tangle-network/agent-provider-sandbox
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
