# @tangle-network/agent-interface

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

- afe552d: Add optional `AgentProfile.harness` — a typed, executor-overridable preferred execution harness (`HarnessType`). Formalizes the `profile.harness` runtimes already read untyped; identity stays harness-agnostic (the leaderboard `harness × model` axis and per-worker supervisor routing still override it), and it becomes a first-class lever an improvement loop can optimize.

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
