# @tangle-network/agent-interface

Shared TypeScript types and zod schemas that define the contract between Tangle
agents, the sidecar, and provider adapters: capabilities, agent profiles,
message parts, and harness descriptors. This is the canonical home for those
shapes; higher-level packages import from here rather than redefining them.

## Durable runs, interactions, and context

`AgentRunControlRef` identifies a retained run without depending on a live JavaScript object and may carry the provider's admission digest so reconstruction can reject changed-input reuse.
`RuntimeEventEnvelope` adds stable run, event, sequence, cursor, and timestamp fields around the existing `StreamEvent` union, and its runtime schema validates every canonical event variant.
The canonical `cancelled` status identifies caller cancellation and remains distinct from `failed`.
Providers advertise `retainedControl` only when exact run, result, event, cancellation, replay, detach, turn, and session identity are all implemented together.
`AgentEnvironment.metadata` is the detached snapshot returned by create or get, so recovery can check persisted annotations without listing environments.
Metadata can include caller-authored values and does not prove authorization or authorship.
`AgentSession.cancelRun()` accepts a canonical request digest bound to one operation and `AgentExactRunControlRef`, so a caller can safely repeat the same cancellation after losing the first acknowledgement.
Its acknowledgement repeats the operation, digest, and run coordinates and distinguishes a known cancellation effect from conflict or unknown state.

An environment advertises `interactions` only when it can originate and answer typed requests.
`RequestedInteractions` defines the bounded per-turn posture for well-known and namespaced provider interaction kinds.
`permission`, `question`, and `plan` keep portable meanings across providers.
`AgentTurnInput.interactions` and `AgentExecutionInput.interactions` carry that posture through shared execution boundaries.
An omitted posture leaves provider defaults unchanged, while an empty object enables no interaction kind for that turn.
`AgentEnvironmentCapabilitiesSchema` strictly validates the complete capability document at runtime, including all-or-nothing durable branching declarations.
Optional provider methods must be absent when their capability is false so clients cannot expose an action the provider has denied.
The capability names supported request kinds, answer field types, response scopes, secret answers, concurrency, replay, and response idempotency.
`AgentEnvironment.respondToInteraction()` and `AgentSession.respondToInteraction()` bind each response to its run, environment, optional provider session, interaction, and caller operation identifier.
Their acknowledgement distinguishes acceptance, exact prior resolution, conflicting prior resolution, expiry, cancellation, unknown interaction, unknown run, binding mismatch, and transport failure.
Acknowledgements deliberately contain no answer value or answer hash because both can disclose low-entropy secret answers.
Response data is accepted only after `validateInteractionResponse()` checks it against the exact outstanding request, rejects undeclared fields, and enforces the request's permission scopes.
An omitted permission scope permits only a one-time response; session and persistent grants must be explicit.
The legacy `SdkProviderAdapter.respondToInteraction(response)` remains source-compatible, while new adapters use `respondToInteractionCommand(command)` for exact binding and durable acknowledgement.

Portable conversation transfer reuses `BackendMessage` and `InputPart` rather than defining another message format.
Planning is represented separately from execution: a plan embeds the immutable source, lists every message and part decision, names the destination runner, contains the exact derived context, and carries a canonical digest.
Every plan request has a canonical request digest, and every ready, over-limit, or unsupported result repeats the request identifier and digest.
`portableContextPlanResultMatchesRequest()` verifies that the result belongs to the exact request, the returned source and destination match, and a ready plan stays within its requested token limit.
Partial input or output always requires explicit user or policy acceptance, even when no individual message was transformed.
`ContextTransferRequest` binds an operation identifier to that accepted plan, while `ContextTransferResult` distinguishes first admission, exact replay, changed-input conflict, and unknown transport outcome.
`contextTransferResultMatchesRequest()` checks the operation identifier and request digest for every outcome before a caller accepts, retries, or reports it.
Its successful receipt repeats the exact destination and carries the provider's session-creation operation and timestamp, identifying the one fresh provider session that admitted the context.
`NativeContextBoundaryProof` is the separate path for same-session continuation and includes the exact run identity.
`NativeContextContinuationRequest.turnDigest` binds the operation to the exact new JSON-stable user turn; timeout and abort controls live outside that turn under `AgentNativeContextContinuationOptions`.
Continuation is valid only when the provider atomically proves the recorded token, revision, digest, or message boundary, sends zero copied history, and applies retry or changed-input conflict semantics.
Providers advertise `nativeContinuation` only when both guarantees are implemented and expose `AgentSession.continueNative()` as the single durable operation.
An accepted or replayed operation returns its original turn result and exact current control reference; `AgentNativeContextContinuationResultSchema` validates that shape and `agentNativeContextContinuationResultMatchesRequest()` checks its request and retained-session bindings.
A changed request with the same operation identifier conflicts without dispatch.

Providers that support recoverable workspace copies expose `workspaceBranching` and set `branching.retrySafe`, `branching.lookup`, and `branching.cleanup` together.
Checkpoint and fork requests bind an idempotency key to a canonical request digest.
Every returned resource repeats and validates that identity, lookups recover remote success after caller restart, changed-input key reuse returns a conflict, and cleanup binds its acknowledgement to the exact provider and target.
A checkpoint with dependent forks returns `in_use` plus the blocking environment identifiers and remains recoverable until those forks are destroyed.
The older `checkpoint()` and `fork()` methods remain source-compatible for providers that have not yet implemented recovery semantics, but clients must not present them as durable workspace branching.

All new wire values have exported Zod schemas on the package root.
Omitting `interactions` and `nativeContinuation`, or leaving the three durable branching flags false, is the compatible declaration for existing providers.

`profile.systemPrompt` declares two independent bits rather than one flag.
`replace` means the provider deletes the harness's own system prompt and installs `prompt.systemPrompt`; `append` means it keeps that prompt and adds `prompt.appendSystemPrompt` to it.
A provider that can only append must declare `replace: false` and refuse a profile carrying `systemPrompt`, because quietly appending a requested replacement leaves the instructions the caller asked to delete in force.



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
      // Most harnesses can only add to their built-in prompt, not delete it.
      systemPrompt: { replace: false, append: true },
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

When caller environment values merge into a bridge or harness process, reject names for which `isRuntimeProcessControlEnvironmentName(name)` returns `true`.
Use `isCredentialBearingProfileConfigName(name)` before retaining public config.
These checks do not apply to a replacement environment owned by caller code.

## Exact process environments

Providers may expose the optional `exactProcess` capability for isolated, reproducible process execution.
It is separate from agent-backed `create()` because it guarantees a fresh environment, immutable image identity, explicit resources, bounded exact-byte file reads, shell-free argv, replacement process environment, recoverable output and terminal reason, bounded network access, and collision-safe idempotent recovery without starting a provider-managed agent.
Higher-level runtimes can use this primitive for measured candidates without making candidate lifecycle part of the provider contract.
Providers must omit the capability unless every property is enforced on their real execution path.

## Frozen improvement candidates

`AgentCandidateBundle` is the portable output of an improvement run: a recursively strict profile, an explicit disabled/no-op/changed code result, a shell-free launch, optional knowledge, isolated memory, ancestry, and spend.
Execution either pins a candidate-selected container in the bundle or delegates container selection to the benchmark evaluator.
For evaluator-owned task images, the protected runtime creates a separate plan for every candidate/task pair and binds the exact result shape (workspace change or bounded typed output), UTF-8 instruction bytes, selected OCI index, manifest, platform, task workspace, model, launch, counted attempt, retry policy, and tool-step limit before execution.
Execution limits may also carry `maxTotalTokens`, which bounds the accounted `inputTokens + outputTokens` total for one arm.
Instruction delivery is closed to one final argv element, exact stdin bytes followed by EOF, or a fixed file path exposed through `TANGLE_CANDIDATE_TASK_PATH`.
That plan also binds the profile target workspace and every mounted path; benchmark adapters must restore or exclude task-targeted profile paths before capturing the submitted solution patch.
Resources are embedded, addressed through closed S3/IPFS locators, or pinned to a full GitHub commit plus content digest.
An imported resource may also retain its immutable source identity and revision, exact source digest, validated SPDX expression or content-pinned custom license, attribution and notices, and an ordered normalization/transformation digest chain.
These provenance fields are part of the candidate digest; changing or omitting an obligation produces a different candidate identity.
Candidate-authored process configuration is explicitly public; model authorization is evaluator-mediated and secret values never belong in the bundle.
Because prompts and inline files are arbitrary text, producers must also run their normal secret scanner before persistence.
Candidate bundles reject unregistered backend extensions instead of accepting an untyped behavior or credential channel.

Each terminal model settlement carries the raw and accounted input tokens for every router call, plus the router's `usageWithinLimits` result.
The settlement usage input total equals accounted input tokens, so aggregate limits cannot be recomputed from raw provider input alone.

`agentCandidateBundleSchema.parse()` proves only that the wire shape is valid.
Before execution, an integrity verifier must omit only the top-level `digest`, canonicalize the rest with RFC 8785, hash the UTF-8 bytes to lowercase `sha256:<hex>`, verify every artifact, apply any Git patch to the declared base tree, and emit an `AgentCandidateMaterializationReceipt`.
Artifact and OCI resolvers must also reject redirects or DNS results that reach loopback, private, or link-local addresses; schema parsing cannot prove network resolution safety.
Attach the materialization and `AgentCandidateRunReceipt` records to the benchmark run so the result names the exact profile plan, code tree, launch plan, selected OCI manifest/platform and source, model, memory isolation, trace, termination, harness, and container that ran.
A timeout, signal, or cancellation remains distinct from a process exit; if the protected evaluator cannot recover complete usage and trace evidence, it must mark the cell as invalid capture instead of minting a zero-usage receipt.

The three code states are intentionally distinct:

- `{ kind: "disabled", reason: "control" }` is the fixed control; `reason: "not-applicable"` keeps code unchanged while another surface is optimized.
- `{ kind: "no-op" }` means a proposer ran and returned no change.
- `{ kind: "git-patch" }` carries a non-empty binary Git diff whose resulting tree must be verified.

## Versioning

This package follows semantic versioning from 1.0.0.

- A minor release is additive. A new export, a new optional field, and a widened union are minor.
- A patch release is a fix. A behaviour correction that keeps every declared type is patch.
- A major release removes or narrows. A deleted export, a removed member, a narrowed type, and a new required field are major.

Declare this package as `^1.0.0`.
A caret range admits every additive minor without a consumer release.
Do not declare a single-generation window such as `>=1.4.0 <1.5.0`; that shape forces a coordinated release across every repository on each minor.

## License

MIT
