# @tangle-network/agent-interface

Shared TypeScript types and zod schemas that define the contract between Tangle
agents, the sidecar, and provider adapters: capabilities, agent profiles,
message parts, and harness descriptors. This is the canonical home for those
shapes; higher-level packages import from here rather than redefining them.

The only runtime dependency is `zod` (used for the schema exports).

## Install

```bash
pnpm add @tangle-network/agent-interface
```

## Usage

```ts
import type { BackendCapabilities, ProviderCapabilities } from "@tangle-network/agent-interface";

const caps: ProviderCapabilities = {
  supportsVision: true,
  supportsLogprobs: false,
  supportsToolCalls: true,
  supportsComputerUse: false,
};
```

## License

MIT
