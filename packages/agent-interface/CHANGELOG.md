# @tangle-network/agent-interface

## 1.1.0

### Minor Changes

- ba5e02f: Add minimal provider-neutral Agent instance contracts for optional managed Agents inside an existing execution environment, including workspace intent, public lifecycle records, profile identity, and idempotent stop acknowledgements.

## 1.0.1

### Patch Changes

- b594b96: Define and enforce canonical idempotency for generic environment creation.
- 249611e: Default the Tangle router to `zai/glm-5.2`, a model the router both routes and
  holds a spend-authorizing price for. The previous default, `zai/glm-4.7`, is
  not in the router catalog, so a managed run that named no model asked for a
  model the router does not carry and received a 503 that a CLI retries until its
  own timeout.

## 1.0.0

### Major Changes

- ca3901d: Adopt a stated compatibility promise and release it as 1.0.0.

  The published surface of 1.0.0 equals the published surface of 0.56.0.
  No export is added, removed, or narrowed by this release.
  The version number changes so that a caret range can read the promise the package already keeps.

  The promise from this release forward:

  - A minor release is additive. A new export, a new optional field, and a new member on an exported union are minor.
  - A patch release is a fix. A behaviour correction that keeps every declared type is patch.
  - A major release removes or narrows. A deleted export, a removed member, a narrowed type, and a new required field are major.

  Two limits of that promise, stated because a caret range makes them reachable:

  - A `switch` over an exported union must have a `default` branch. An exhaustiveness check that assigns the remaining case to `never` fails when a minor adds a member, and this promise does not cover it.
  - Declare the lowest 1.x you actually use. A package that reads an export added in 1.4.0 must declare `^1.4.0`, because `^1.0.0` lets a resolver keep 1.0.0.

  Consumers must declare `^1.<lowest minor used>.0`.
  A caret range admits every later additive minor without a consumer release.
  The single-generation window `>=X.Y.0 <X.(Y+1).0` is retired and must not be reintroduced.

## 0.56.0

### Minor Changes

- 4245a0b: Bind exact interactive session references to the canonical execution preparation receipt.

  Add retry-safe typed prompt commands and provider-issued control claims for prompt, stop, and writable terminal attachment.

## 0.55.0

### Minor Changes

- 986ef57: Add durable references and controls for exact native coding-agent TUI sessions.

  The contract binds each session to one canonical start request, exact run, requested profile, admitted profile, harness, and process incarnation.
  It keeps generic shell terminals separate from native coding-agent sessions.

## 0.54.0

### Minor Changes

- d7be4d4: Allow namespaced provider interaction kinds to use the canonical per-turn request, response, and replay protocol.
  Make omitted posture keys type as `boolean | undefined`.
  Export shared checks for credential-bearing config names and runtime process-control environment names.

## 0.53.0

### Minor Changes

- 5ab7e8c: Carry strict per-turn interaction requests from the shared interface to Sandbox backend prompt options.

## 0.52.0

### Minor Changes

- c4e1978: Add caller cancellation as a canonical stream status and keep the Agent Core status type aligned with that contract.
- 18dd3ce: State the replay cursors an interactive terminal can serve.

  `AgentTerminalSession` now carries `cursors`, the `earliest` cursor `events` accepts and the `latest` frame the handle holds, validated by `TerminalReplayWindowSchema`.
  A terminal retains a bounded number of frames, so a consumer that holds no cursor, or holds one the handle dropped, reads the window and resumes from a cursor that still exists instead of being refused for good.

## 0.51.0

### Minor Changes

- 3cdb9d4: Expose detached environment metadata and preserve a recursively frozen Sandbox metadata snapshot in the Tangle provider.

## 0.50.0

### Minor Changes

- bdb076b: Add the environment-scoped capability document.

  `AgentEnvironment.capabilities` is an optional document that describes one environment.
  A capability the connected deployment decides cannot be stated by `AgentEnvironmentProvider.capabilities()`, because one provider reaches deployments of different ages; a provider that measures such a capability per environment publishes the measured answer here, and the operations that environment exposes match it.

  `runAgentEnvironmentProviderConformance` and `runSessionReplayConformance` now bind every environment-scoped check to that document when the environment publishes one, and to the provider document otherwise.
  The provider report gains `environmentCapabilities`, which is the document the checks ran against.

## 0.49.0

### Minor Changes

- a47e59e: Add an optional `maxTotalTokens` execution limit for the accounted input and output token total.
  Terminal model settlements now carry required accounted input tokens per call and the router's `usageWithinLimits` result.
  The strict schemas reject missing or malformed accounting fields.
- d93bac3: Add an optional normalized environment observation surface and an optional provider-neutral interactive-terminal contract.
  Each observation carries a required freshness discriminator, so a missing value never reads as a measured zero, and the endpoint type holds no credential field.
  All additions are optional and additive; a provider that declares neither surface still validates.

## 0.48.0

### Minor Changes

- c9856a0: Reject non-canonical inputs, add narrow subpath exports, and add typed token
  limits to model hints.

  `isCanonicalJsonValue` now rejects a sparse array. `Array.prototype.every` and
  `Array.prototype.map` both skip holes, so a sparse `Array(1)` passed validation
  and then serialized to the same bytes as a dense `[]`. Two observably different
  values collapsed to one content digest, which read as false idempotency. The
  serializer output is unchanged, so existing digests hold; only the input gate is
  stricter. A dense `[null]` still passes.

  `InteractionDataSchema` now rejects a reserved key rather than silently dropping
  it. A record parser assigns keys onto an ordinary object, so a raw own
  `__proto__` invoked the legacy prototype setter and vanished before the field
  name schema ran, and `InteractionDataSchema.safeParse(JSON.parse('{"__proto__":"x"}'))`
  returned an empty object while `validateInteractionResponse` rejected the same
  input. The schema now inspects the raw own keys, fails loud on `__proto__`,
  `constructor`, or `prototype`, and still returns a null-prototype object. The two
  paths now agree. The reserved-name set has one owner in `interaction-fields`.

  The package now declares narrow subpath exports for the existing leaf modules:
  `profile`, `profile-snapshot`, `profile-schema`, `profile-security`, `harness`,
  `harness-capabilities`, and `interaction`. A caller can load one leaf without
  evaluating the root barrel graph.

  `AgentProfile.model` gains three optional token ceilings:
  `maxVisibleOutputTokens`, `maxReasoningTokens`, and `maxTotalOutputTokens`. Each
  is a positive integer, and each is independent. A refinement fails loud when a
  single ceiling exceeds the total; it never clamps. `reasoningEffort` stays a
  quality dial and never bounds spend. This change is the schema half only.
  Provider and materializer enforcement — recording requested against applied and
  lowering to a provider's `max_tokens` or `max_completion_tokens` before spend —
  is a tracked phase 2, the same split used for #146 and #154.

  The two input rejections are stricter validation. For a 0.x package a minor
  release is correct. A caller that relied on a sparse array or a `__proto__` key
  passing now receives a validation error; no caller in this repository does.

## 0.47.0

### Minor Changes

- facff5c: Export a model-facing JSON Schema generated from the canonical `AgentProfile` validator.

### Patch Changes

- facff5c: Document and test that authored harness and model-routing preferences participate in canonical profile identity while execution receipts separately bind overrides.

## 0.46.1

### Patch Changes

- 077635f: Add exact provider-turn interaction binding to `AgentExecutionInput` so runtimes and provider adapters share one typed identity contract.

## 0.46.0

### Minor Changes

- b44d502: Expose exact, digest-bound run-control requests and acknowledgements for retry-safe steering, cancellation, status, and reconnect operations.

  Split interaction, context transfer, workspace branching, provider conformance, and Tangle environment behavior into focused public modules while preserving the package-root API.

  Harden provider inputs, replay identity, cleanup ownership, iterator cancellation, capability reporting, and packed-consumer checks.

- d27deb9: Omit unset optional keys from merged and diffed profiles instead of writing them as `undefined`.

  `mergeAgentProfiles` wrote every axis it resolved, so merging two profiles that mention neither `tools` nor `mcp` still produced `{ tools: undefined, mcp: undefined, … }` — eleven keys on a two-key merge. RFC 8785 canonicalization enumerates own keys, so that shape is not the same document as one omitting them: `canonicalCandidateJson` refuses it outright. `applyAgentProfileDiff` and `defineGitHubResource` blanked keys the same way and now delete them.

  This changes published merge semantics, so it is a minor rather than a patch: an overlay entry holding `undefined` no longer erases the base value. `{ harness: 'codex' }` merged with `{ harness: undefined }` now keeps `codex`, matching the rule profile canonicalization already applies — an `undefined` entry reads as "not specified", and removal stays the `remove` channel's job.

## 0.45.0

### Minor Changes

- d8020a5: Add `prime` (PrimeIntellect prime-agent, the RLM fork of the pi line) to the canonical harness enum, with its reasoning-effort set (`none…ultracode`, mapping to the fork's `--thinking off…max`) and system-prompt controls (`replace` + `append`). `prime` is router-backed: no provider lock. It is deliberately distinct from `pi` — the fork's wire protocol has diverged and its daemon rejects pi-line clients.

## 0.44.0

### Minor Changes

- 3bbafd2: Separate replacing the harness's system prompt from adding to it.

  `AgentProfilePrompt.systemPrompt` was documented as full replacement but reached most harnesses as an addition — `agent-provider-cli-bridge` pushes it as a leading `role: "system"` message on top of the harness's own prompt, and claude-code folds it into `--append-system-prompt`. Only harnesses with a real replacement control (`pi --system-prompt` with context files, skills, and templates off; gemini `.gemini/system.md`) delete the built-in prompt. One field carried two opposite meanings and nothing reported which one a caller got, so a profile written to remove the harness's instructions silently ran with them still in force.

  Add `AgentProfilePrompt.appendSystemPrompt` for the additive intent, distinct from both `systemPrompt` (replacement) and `instructions` (the lower-privilege project-instruction surface). Setting replacement and addition together is legal and ordered — the addition composes on top of the replacement — because `mergeAgentProfiles` composes the two fields independently, and refusing the pair would let two valid profiles merge into an invalid one. Additive text now concatenates on merge rather than overwriting, so an overlay cannot silently delete what a base added.

  Change `AgentProfileCapabilities.systemPrompt` from `boolean` to `{ replace: boolean; append: boolean }`, both required. A backend that can only add text declares `replace: false` and must refuse a profile carrying `systemPrompt` instead of appending it. The object is required rather than an added optional flag so every declaration site is a compile error and every capability document still carrying the bare boolean fails validation, rather than being read as "replacement supported" — which for every append-only backend is false.

  Carry the split through the rest of the contract: `appendSystemPrompt` is the thirtieth canonical materialization leaf at `/prompt/appendSystemPrompt`, `AgentProfilePromptRemoval` can remove either intent alone, and `AgentCandidateProfilePlanMaterial` records the added prompt separately from the replacement so the same bytes under the two intents are two different plan identities.

  Declare the measured bits at every provider, from the harness rather than from the wire. `harnessSystemPromptIntents(harness)` joins the harness capability layer as the single measured table: claude-code and pi own both intents, codex and gemini own replacement only, opencode owns addition only, and every other harness owns neither — including the ones whose prompt path is a `role: "system"` chat message, which is flattened into the user turn before the CLI sees it. `defaultCliBridgeCapabilities(harness?)` and `defaultTangleSandboxCapabilities(harness?)` now read that table; both adapters forward the profile to a layer that picks the harness, so an unnamed harness declares `{ replace: false, append: false }` rather than promising what it cannot check. Declaring from expressibility was the failure this replaces — a caller reading `replace: true` from the tangle adapter and running an opencode sandbox got a refusal. daytona, e2b, and computesdk materialize no profile prompt and keep `{ replace: false, append: false }`.

  `harnessSystemPromptIntents` answers for a plan-forwarding executor, and now says so. Both callers lower a profile to files, env vars, and flags and hand the result to a launcher they do not own, so the harness alone decides what they can promise. One control in the table does not fit that shape: opencode's `agent.<name>.prompt` really does replace its built-in prompt, but it binds to the single agent whoever starts the server selects, which a plan cannot name — so `opencode` reads `replace: false` here while an executor that writes opencode's server config and picks the primary agent honors replacement and declares `replace: true` for itself. The table stays harness-keyed rather than widening: a `true` there would promise the intent to every plan-forwarding caller, and none of them can deliver it. An executor that owns a launcher control states that where it binds it.

  Stop `agent-provider-cli-bridge` synthesizing a `role: "system"` message from `prompt.systemPrompt`. It lowered the replacement intent as an addition — the defect this release exists to remove — and, since the same request also carries `agent_profile`, the bridge rejected it outright for mixing system-role messages with a profile. Both intents now travel only on `agent_profile`, where the bridge binds each to the control its harness owns or refuses it.

## 0.43.1

### Patch Changes

- 682814e: Offer codex `none` and pi `ultracode` in the reasoning-effort sets.

  Both were measured against the pinned CLI binaries and both were reachable all along: the codex API enumerates `none` first in its own error, and `pi --thinking` accepts `max`, which canonical `ultracode` maps to. The picker hid them, so turning thinking off on codex and reaching pi's top rung were not selectable.

## 0.43.0

### Minor Changes

- 7000e82: Define explicit retained-run capability proof and digest-bound, retry-safe cancellation requests and acknowledgements.

## 0.42.1

### Patch Changes

- f681bb0: Add caller-defined maximum lengths to text and secret interaction fields and enforce them when validating answers.

## 0.42.0

### Minor Changes

- cece8b3: Bind native same-session continuation requests to the exact new turn digest.
  Add an optional provider capability and session operation that atomically verifies the boundary, durably admits one operation identifier and request digest, returns a runtime-validated result plus current control reference, replays that exact outcome after uncertain transport failures, and rejects changed input without dispatch.

  Keep timeout and abort controls outside the digest-bound turn.
  Extend portable-context conformance to prove exact turn binding, result and control-reference recovery, changed-turn conflict, and zero duplicate continuation effects.

## 0.41.0

### Minor Changes

- 7011e7e: Add provider-neutral durable run references, strictly validated capabilities and replayable event envelopes, scope-bound interaction acknowledgements, request-bound portable context transfer with enforced token limits and provider-confirmed fresh sessions, retry-safe native continuation, and recoverable workspace branching contracts.
  Keep the original SDK adapter interaction method source-compatible and add a separate durable command method.

  Add reusable conformance checks for detached competing-run isolation, every interaction acknowledgement outcome, real over-limit planning, cross-request rejection, context receipts, retry conflicts, continuation boundaries, workspace operation recovery, dependency-ordered cleanup, absent disabled operations, and combined operation/cleanup failures.

  Add exact session and immutable execution control references to detached and reconstructed Tangle sessions, bind result, replay, and cancel to that exact execution, validate capability and Sandbox result data, omit disabled methods, adapt inclusive Sandbox replay to exclusive cursors, reject unproven or mismatched receipts without advancing local state, and fail explicitly for unsupported context inputs.
  Pack and test the Tangle provider together with the interface, testkit, and public Sandbox 0.17.0 dependency.

- 32acb32: Add `forge` and `cursor` to `HarnessType` / `harnessTypeSchema`.

  Both ship full provider adapters downstream (`sdk-provider-forge`,
  `sdk-provider-cursor`), but were absent from the canonical enum, which forced
  agent-dev-container and agent-app to maintain divergent copies of the harness
  taxonomy. They are multi-provider CLI runners with no vendor lock, so they carry
  no entry in the capability tables and resolve as router-backed — matching the
  behavior downstream already relied on.

## 0.40.0

### Minor Changes

- 886666b: Add the canonical `snapshotAgentProfile` intake function to detach, validate, and recursively freeze an exact `AgentProfile` without adding execution policy or defaults.

## 0.39.0

### Minor Changes

- 7c68070: Accept exact `AgentProfileDiff` changes across every profile axis in measured profile-improvement experiments while preserving existing granular surface labels.
- dfec816: Add a canonical `diffAgentProfiles` inverse that constructs deterministic existing `AgentProfileDiff` steps across every profile axis.

## 0.38.0

### Minor Changes

- 71d3391: Add a strict pre-compute execution preparation receipt with exact AgentProfile path coverage, model fidelity, workspace lease/source/prepared-content binding, profile activation evidence, expiry, and canonical digest validation.
  Represent MCP arguments, environment, headers, and hook environment as explicit public values or opaque secret references, while treating all remaining profile text and reference keys as caller-declared public identity with recognizable-pattern refusal as defense in depth.
  Add a self-hashed provider-neutral workspace lease lifecycle whose sealed and execution-bound phases connect source policy, profile activation, prepared content, and the exact execution-preparation receipt without serializing the private owner capability.

## 0.37.0

### Minor Changes

- 6ebe9d2: Add content-bound source, license, attribution, notice, and transformation provenance to frozen candidate resources.

## 0.36.0

### Minor Changes

- c8da041: Require an `executionRef` on every measured profile-improvement experiment and run receipt.
  Activation records targeting `agent-profile` must carry that reference, and validators reject receipts produced by a different runner.

## 0.35.0

### Minor Changes

- 87bae75: Require candidate and profile-improvement run receipts to record executed steps.
  Validate duration, steps, model calls, input tokens, output tokens, and execution spend against the exact frozen limits before evidence can support an improvement decision.

### Patch Changes

- 0660698: Export the candidate identity primitives (`Sha256Digest`, `sha256DigestSchema`, `sha256Utf8`, `sha256Bytes`, `canonicalCandidateJson`, `canonicalCandidateBytes`, `canonicalCandidateDigest`) as explicit named exports on the package root so external consumers can rely on them independent of internal barrel layout.

## 0.34.0

### Minor Changes

- dc2990e: Add a portable, validated source reference for signed agent improvement proposals.
- 9483fb0: Define source-bound measured prompt and skill improvements as ordered `AgentProfileDiff` patches without persisting full profiles.
  Use `candidateDigest` as the activation record's single candidate identity field.
  Remove the old question adapter types and helper; providers now emit `InteractionRequest` directly.
  Require canonical runner names and remove shorthand runner aliases and normalization.

## 0.33.0

### Minor Changes

- b24db38: Define immutable, tenant-bound context delivery for Tangle Intelligence.

## 0.32.0

### Minor Changes

- fada902: Define a provider-neutral exact process environment with immutable images, explicit resources, bounded exact-byte files, collision-safe creation, and recoverable shell-free processes with exact terminal reasons.
  Implement provider-secret-free, network-limited execution and recovery for attested Tangle sandboxes, with reusable lifecycle checks for every contract.

## 0.31.0

### Minor Changes

- d8227eb: Add expiring apply/restore authorizations and typed idempotent activation outcomes.

## 0.30.0

### Minor Changes

- 4074c47: Reject unknown fields at every defined AgentProfile object boundary, make profile and candidate MCP definitions exact local, remote, or disabled configurations, align reasoning capabilities with the native CLI controls, and bind exact system-prompt replacement to candidate profile-plan identity.

## 0.29.0

### Minor Changes

- e1c362e: Add one immutable candidate experiment shared by evaluation and execution, with exact baseline and candidate bundles, benchmark tasks, repetitions, seeds, and Runtime receipts.

### Patch Changes

- a00d0a3: Build only before publishing so installed package artifacts can be repacked with lifecycle scripts enabled.

## 0.28.0

### Minor Changes

- f6dfea0: Collapse the unlaunched candidate, profile-diff, and improvement contracts to one canonical shape without schema version fields or frozen compatibility exports.

## 0.27.2

### Patch Changes

- d6685fa: Declare the package side-effect-free so bundlers tree-shake unused modules (the deprecated candidate compat schemas in particular) out of application bundles.

## 0.27.1

### Patch Changes

- 0103410: Restore the pre-unification candidate outcome and receipt exports as deprecated compatibility aliases so published consumers that still import the old names resolve at ESM import time. Shape-identical renames (profile-plan/benchmark-result material, settlement call and settlement material V2, and their schemas) re-export the current symbols; symbols whose shape changed (bundle/workspace-manifest/execution-plan/materialization-receipt/run-receipt V1, run-receipt V2, the run-receipt union, settlement material V1, and model usage) are re-declared under their frozen shapes. `sameFixedSpend` is re-exported.

## 0.27.0

### Minor Changes

- f10a949: Add the durable plan submission host, typed plan continuation, plan stream record, and required execution outcome contract.

## 0.26.1

### Patch Changes

- 8f8d4bb: Validate large embedded base64 artifacts with a stack-safe linear scan instead of a backtracking regular expression.

## 0.26.0

### Minor Changes

- d5d542d: Candidate tasks can declare either a workspace change or a bounded media output.
  Repository identity is tracked independently, and output receipts retain their media constraints.
  The package now owns the improvement proposal, review, measured comparison, and successful execution evidence schemas.
  Candidate bundles, workspace records, execution plans, materialization receipts, model-settlement evidence, and task outcomes use version 2; run receipts use version 3.
  Model-settlement material retains its previously published version 2 shape.

### Patch Changes

- d5d542d: Preserve absent resource arrays when merging agent profiles so empty profile diffs remain no-ops.

## 0.25.0

### Minor Changes

- a26171f: Bind the exact benchmark grader implementation to every candidate execution plan.

## 0.24.0

### Minor Changes

- 8b2576f: Add a backward-compatible V2 candidate model settlement that binds every model call to its router-generated identity, terminal status, exact timing, token accounting, and fixed-point cost.

## 0.23.0

### Minor Changes

- bca9ea6: Bind each model-calling candidate execution plan to an exact evaluator-approved gateway domain allowlist while preserving disabled general network access.

## 0.22.0

### Minor Changes

- 96c6e84: Add V2 candidate run receipts with fixed-point model usage, per-call settlement evidence, exact repository outcomes, and pinned benchmark results.

### Patch Changes

- 73759a5: Require every candidate benchmark result to carry a non-empty durable reference to the raw grader output behind its score and pass verdict.

## 0.21.0

### Minor Changes

- 2d70211: Add the versioned sealed `AgentCandidateBundle` contract with content-addressed profile, source, built-workspace, task, and trace evidence; one exact model and reasoning effort; evaluator-owned authorization; shell-free network-disabled execution; fresh task-scoped memory; lineage and spend; RFC 8785 identity documents; and materialization and run receipts.

### Patch Changes

- f5cbf34: Bind the exact UTF-8 task instruction digest, byte length, and closed delivery mode in every candidate execution plan.
- 9ad63d0: Add the profile harness preference to `AgentProfileDiff` set, removal, changed-axis, and pruning operations, while ensuring removals and pruned fields cannot affect unrelated profile axes.

## 0.20.0

### Minor Changes

- afe552d: Add optional `AgentProfile.harness` — a typed, executor-overridable preferred execution harness (`HarnessType`). Formalizes the `profile.harness` runtimes already read untyped; the authored preference participates in canonical profile identity while execution receipts separately bind any override, and it becomes a first-class lever an improvement loop can optimize.

## 0.19.0

### Minor Changes

- e0a8e98: Add AgentProfileDiff, a portable full-profile patch contract with apply, prune, changed-axis, and schema validation helpers.

## 0.18.0

### Minor Changes

- 1f2821b: Add `allowCustom` to select interaction fields: when set, `validateInteractionAnswer` accepts non-blank write-in values beyond the declared options, and `questionAnswerSpec` propagates the flag from `LegacyQuestion.allowCustom`. Enables "Other…" style questions where the user supplies their own text as the answer value.

## 0.17.1

### Patch Changes

- f7ca568: Align Codex reasoning support with the live model catalog in harness capability helpers.

## 0.17.0

### Minor Changes

- 175521c: Reconcile per-harness reasoning-effort sets with the real cli-bridge adapters so the chat picker no
  longer offers levels a harness can't actually run (gtm-agent#398):

  - `codex` → `minimal·low·medium·high` (drop the inert `none`; xhigh/ultracode aren't accepted)
  - `claude-code` → `low·medium·high·xhigh·ultracode` (its `--effort` ladder; `ultracode` stands in for
    the adapter's `max`; `none`/`minimal` dropped as redundant)
  - `pi` / `openclaw` → cap at `xhigh`
  - `kimi-code` → binary `minimal`/`high` (its `--thinking` on/off toggle), not five levels
  - `acp` added to the ignore-effort set (its runner reads no `reasoningEffort`)

  Adds an explicit `harnessReasoningEffortsOverride` for non-`none…ceiling` sets; `harnessReasoningEfforts`
  prefers it over the ceiling slice.

## 0.16.0

### Minor Changes

- dd7c4fe: Add harness selector-support capability: `harnessHonorsModel`, `harnessHonorsEffort`, and
  `harnessHonorsSelectors`. These report whether a harness's runner actually honors the per-turn model
  and reasoning-effort pickers (grounded in the cli-bridge adapter audit: `amp` drops both;
  `openclaw`/`nanoclaw` drop the model; `factory-droids`/`hermes`/`nanoclaw` drop the effort). Chat
  pickers use these to trim or mark harnesses up front, so a user's model/effort choice is never
  silently ignored. Distinct from `reasoningEffortsFor` (which levels a harness can express).

## 0.15.0

### Minor Changes

- ecd2adc: Make agent-interface the single source of truth for harness↔model snapping, and correct nanoclaw's capabilities.

  - `nanoclaw` is now treated as router-backed (runs any model via the Tangle router) instead of Anthropic-locked, and its reasoning ceiling is `none` (its runner sends no thinking flag) instead of `ultracode`.
  - Add `snapModelToHarness(harness, modelId, candidateIds)` and `snapHarnessToModel(harness, modelId)` so consumers (sandbox-ui, agent-app) import the catalog-aware snap logic instead of hand-rolling divergent copies.

## 0.14.0

### Minor Changes

- 6591b16: Add the provider-neutral agent environment contract plus provider packages for Tangle Sandbox, CLI bridge, ComputeSDK, E2B, Daytona, and shared provider conformance tests.

## 0.13.0

### Minor Changes

- 5d8d8ec: BREAKING: remove the deprecated `question` stream event and `submitQuestionAnswer` adapter method. Use the generalized `interaction` event (`kind: "question"`) and `respondToInteraction` introduced in 0.12.0.

## 0.12.0

### Minor Changes

- c63e325: Add the generalized interaction contract for human-in-the-loop.

  `InteractionRequest`/`InteractionResponse` envelope with a self-describing `answerSpec` (text/number/boolean/select/secret fields), an open `kind` label (well-known: `question`, `permission`, `plan`), graduated `PermissionGrant` values, generic `validateInteractionAnswer`, the `respondToInteraction` adapter method, and a `BackendCapabilities.interactions` declaration. New ask types need no contract change; the shape mirrors MCP elicitation. The legacy `question` stream event and `submitQuestionAnswer` adapter method remain (deprecated) for back-compat.
