# agent-sdk

Public home of the TypeScript SDK for building against Tangle agents. This is a
pnpm workspace containing two published packages:

| Package | Description |
| --- | --- |
| [`@tangle-network/agent-interface`](packages/agent-interface) | Shared TypeScript types and zod schemas defining the agent/provider contract. Zero runtime beyond zod. |
| [`@tangle-network/agent-core`](packages/agent-core) | Runtime primitives for talking to Tangle agents: auth token issue/verify, SSE stream parsing, transport interfaces, retries/resilience, and telemetry. Depends on `@tangle-network/agent-interface`. |

## Install

```bash
pnpm add @tangle-network/agent-core @tangle-network/agent-interface
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
