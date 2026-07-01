# @tangle-network/agent-interface

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
