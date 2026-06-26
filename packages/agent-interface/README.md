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
import type {
  AgentEnvironmentProvider,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  BackendCapabilities,
  ProviderCapabilities,
} from "@tangle-network/agent-interface";

const caps: ProviderCapabilities = {
  supportsVision: true,
  supportsLogprobs: false,
  supportsToolCalls: true,
  supportsComputerUse: false,
};

const provider: AgentEnvironmentProvider = {
  name: "example",
  capabilities: () => ({
    profile: {
      namedProfiles: false,
      systemPrompt: true,
      instructions: true,
      tools: true,
      permissions: true,
      mcp: true,
      subagents: false,
      resources: { files: true, instructions: true, tools: true },
      hooks: false,
      modes: false,
      runtimeUpdate: false,
      validation: true,
    },
    streaming: { live: true, replay: false, detach: false, turnIdempotency: false },
    sessions: { continue: false, list: false, messages: false },
    workspace: { read: true, write: true, exec: true, git: false, upload: false, download: false },
    branching: { checkpoint: false, fork: false },
    placement: false,
    usage: true,
    confidential: false,
  }),
  create: async () => {
    throw new Error("implement provider create()");
  },
};
```

## License

MIT
