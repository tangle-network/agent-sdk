# @tangle-network/agent-core

Runtime primitives for talking to Tangle agents:

- **Auth** — issue and verify scoped access tokens for sidecar/session access.
- **SSE** — parse agent event streams (`SSEChunkParser`, `parseSSEStream`, `parseSSEData`).
- **Transport** — connection-manager and transport interfaces.
- **Resilience** — retries, timeouts, and circuit breakers.
- **Telemetry** — GenAI attribute and token-usage helpers.
- **Interactions** — shared permission, question, and plan transports for agent runners.

This package depends on [`@tangle-network/agent-interface`](../agent-interface) for shared types and schemas.

## Install

```bash
pnpm add @tangle-network/agent-core @tangle-network/agent-interface
```

Requires Node.js 18 or later.
The auth and interaction modules use Node.js networking and cryptography APIs.

## Subpath exports

```ts
import { } from "@tangle-network/agent-core";            // top-level
import { } from "@tangle-network/agent-core/auth";       // token issue/verify
import { } from "@tangle-network/agent-core/sse";        // SSE parsing
import { } from "@tangle-network/agent-core/transport";  // transport interfaces
import { } from "@tangle-network/agent-core/resilience"; // retries / breakers
import { } from "@tangle-network/agent-core/interactions"; // user interactions
```

## Runner interactions

Use one `InteractionBroker` for the active runner session.
The broker emits canonical interaction events and blocks the runner until the UI responds.
It applies the declared default when the response times out.
Session teardown denies pending permissions and cancels pending questions.

```ts
import {
  brokerInteractionTools,
  InteractionBroker,
} from "@tangle-network/agent-core/interactions";
import { InteractionMcpServer } from "@tangle-network/agent-core/interactions/mcp";

const broker = new InteractionBroker({ decisionTimeoutMs: 60_000 });
const server = new InteractionMcpServer({
  ...brokerInteractionTools(broker, {
    sessionId,
    binding,
    emit: onEvent,
  }),
});

await server.start();
// Configure the runner with server.url and `Authorization: Bearer ${server.token}`.
```

`InteractionMcpServer` supports MCP-capable runners.
`InteractionHttpBridge` supports runners that provide extension hooks but do not support MCP.
Both transports use the same broker and canonical Agent Interface contracts.
Install `@modelcontextprotocol/sdk` only when you use the MCP transport.

## License

MIT
