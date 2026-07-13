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

## Frozen improvement candidates

`AgentCandidateBundle` is the portable output of an improvement run: a recursively strict profile, an explicit disabled/no-op/changed code result, a shell-free launch, optional knowledge, isolated memory, ancestry, and spend.
Execution either pins a candidate-selected container in the bundle or delegates container selection to the benchmark evaluator.
For evaluator-owned task images, the protected runtime creates a separate plan for every candidate/task pair and binds the exact result shape (workspace change or bounded typed output), UTF-8 instruction bytes, selected OCI index, manifest, platform, task workspace, model, launch, counted attempt, retry policy, and tool-step limit before execution.
Instruction delivery is closed to one final argv element, exact stdin bytes followed by EOF, or a fixed file path exposed through `TANGLE_CANDIDATE_TASK_PATH`.
That plan also binds the profile target workspace and every mounted path; benchmark adapters must restore or exclude task-targeted profile paths before capturing the submitted solution patch.
Resources are embedded, addressed through closed S3/IPFS locators, or pinned to a full GitHub commit plus content digest.
Candidate-authored process configuration is explicitly public; model authorization is evaluator-mediated and secret values never belong in the bundle.
Because prompts and inline files are arbitrary text, producers must also run their normal secret scanner before persistence.
Candidate v1 rejects unregistered backend extensions instead of accepting an untyped behavior or credential channel.

`agentCandidateBundleSchema.parse()` proves only that the wire shape is valid.
Before execution, an integrity verifier must omit only the top-level `digest`, canonicalize the rest with RFC 8785, hash the UTF-8 bytes to lowercase `sha256:<hex>`, verify every artifact, apply any Git patch to the declared base tree, and emit an `AgentCandidateMaterializationReceipt`.
Artifact and OCI resolvers must also reject redirects or DNS results that reach loopback, private, or link-local addresses; schema parsing cannot prove network resolution safety.
Attach the materialization and `AgentCandidateRunReceipt` records to the benchmark run so the result names the exact profile plan, code tree, launch plan, selected OCI manifest/platform and source, model, memory isolation, trace, termination, harness, and container that ran.
A timeout, signal, or cancellation remains distinct from a process exit; if the protected evaluator cannot recover complete usage and trace evidence, it must mark the cell as invalid capture instead of minting a zero-usage receipt.

The three code states are intentionally distinct:

- `{ kind: "disabled", reason: "control" }` is the fixed control; `reason: "not-applicable"` keeps code unchanged while another surface is optimized.
- `{ kind: "no-op" }` means a proposer ran and returned no change.
- `{ kind: "git-patch" }` carries a non-empty binary Git diff whose resulting tree must be verified.

## License

MIT
