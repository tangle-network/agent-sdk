# @tangle-network/agent-interface

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
