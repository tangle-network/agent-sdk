# @tangle-network/agent-interface

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
