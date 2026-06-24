# @tangle-network/agent-core

Runtime primitives for talking to Tangle agents:

- **Auth** — issue and verify scoped access tokens for sidecar/session access.
- **SSE** — parse agent event streams (`SSEChunkParser`, `parseSSEStream`, `parseSSEData`).
- **Transport** — connection-manager and transport interfaces.
- **Resilience** — retries, timeouts, and circuit breakers.
- **Telemetry** — GenAI attribute and token-usage helpers.

Depends on [`@tangle-network/agent-interface`](../agent-interface) for the shared
type/schema contract.

## Install

```bash
pnpm add @tangle-network/agent-core @tangle-network/agent-interface
```

Requires Node.js >= 18 — the auth module uses `node:crypto` for token signing and
verification.

## Subpath exports

```ts
import { } from "@tangle-network/agent-core";            // top-level
import { } from "@tangle-network/agent-core/auth";       // token issue/verify
import { } from "@tangle-network/agent-core/sse";        // SSE parsing
import { } from "@tangle-network/agent-core/transport";  // transport interfaces
import { } from "@tangle-network/agent-core/resilience"; // retries / breakers
```

## License

MIT
