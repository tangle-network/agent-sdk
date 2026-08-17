# @tangle-network/agent-provider-testkit

## 0.8.3

### Patch Changes

- b594b96: Define and enforce canonical idempotency for generic environment creation.
- Updated dependencies [b594b96]
- Updated dependencies [249611e]
  - @tangle-network/agent-interface@1.0.1

## 0.8.2

### Patch Changes

- Updated dependencies [ca3901d]
  - @tangle-network/agent-interface@1.0.0

## 0.8.1

### Patch Changes

- 09a4304: Reject mismatched or replaced Tangle interactive processes before control, status, or terminal operations.
  Test providers whose launch reserves the first control generation.

## 0.8.0

### Minor Changes

- 5b99d49: Implement the exact Agent Interface 0.56 native interactive session contract.

  Bind sessions to canonical provider receipts, replay-safe control claims, typed prompt and stop commands, and claim-bound terminal mutations.

## 0.7.6

### Patch Changes

- Updated dependencies [4245a0b]
  - @tangle-network/agent-interface@0.56.0

## 0.7.5

### Patch Changes

- Updated dependencies [986ef57]
  - @tangle-network/agent-interface@0.55.0

## 0.7.4

### Patch Changes

- Updated dependencies [d7be4d4]
  - @tangle-network/agent-interface@0.54.0

## 0.7.3

### Patch Changes

- Updated dependencies [5ab7e8c]
  - @tangle-network/agent-interface@0.53.0

## 0.7.2

### Patch Changes

- Updated dependencies [c4e1978]
- Updated dependencies [18dd3ce]
  - @tangle-network/agent-interface@0.52.0

## 0.7.1

### Patch Changes

- Updated dependencies [3cdb9d4]
  - @tangle-network/agent-interface@0.51.0

## 0.7.0

### Minor Changes

- bdb076b: Add the environment-scoped capability document.

  `AgentEnvironment.capabilities` is an optional document that describes one environment.
  A capability the connected deployment decides cannot be stated by `AgentEnvironmentProvider.capabilities()`, because one provider reaches deployments of different ages; a provider that measures such a capability per environment publishes the measured answer here, and the operations that environment exposes match it.

  `runAgentEnvironmentProviderConformance` and `runSessionReplayConformance` now bind every environment-scoped check to that document when the environment publishes one, and to the provider document otherwise.
  The provider report gains `environmentCapabilities`, which is the document the checks ran against.

### Patch Changes

- Updated dependencies [bdb076b]
  - @tangle-network/agent-interface@0.50.0

## 0.6.4

### Patch Changes

- Updated dependencies [a47e59e]
- Updated dependencies [d93bac3]
  - @tangle-network/agent-interface@0.49.0

## 0.6.3

### Patch Changes

- Updated dependencies [c9856a0]
  - @tangle-network/agent-interface@0.48.0

## 0.6.2

### Patch Changes

- Updated dependencies [facff5c]
- Updated dependencies [facff5c]
  - @tangle-network/agent-interface@0.47.0

## 0.6.1

### Patch Changes

- Updated dependencies [077635f]
  - @tangle-network/agent-interface@0.46.1

## 0.6.0

### Minor Changes

- b44d502: Expose exact, digest-bound run-control requests and acknowledgements for retry-safe steering, cancellation, status, and reconnect operations.

  Split interaction, context transfer, workspace branching, provider conformance, and Tangle environment behavior into focused public modules while preserving the package-root API.

  Harden provider inputs, replay identity, cleanup ownership, iterator cancellation, capability reporting, and packed-consumer checks.

### Patch Changes

- Updated dependencies [b44d502]
- Updated dependencies [d27deb9]
  - @tangle-network/agent-interface@0.46.0

## 0.5.5

### Patch Changes

- Updated dependencies [d8020a5]
  - @tangle-network/agent-interface@0.45.0

## 0.5.4

### Patch Changes

- Updated dependencies [3bbafd2]
  - @tangle-network/agent-interface@0.44.0

## 0.5.3

### Patch Changes

- Updated dependencies [682814e]
  - @tangle-network/agent-interface@0.43.1

## 0.5.2

### Patch Changes

- Updated dependencies [7000e82]
  - @tangle-network/agent-interface@0.43.0

## 0.5.1

### Patch Changes

- Updated dependencies [f681bb0]
  - @tangle-network/agent-interface@0.42.1

## 0.5.0

### Minor Changes

- cece8b3: Bind native same-session continuation requests to the exact new turn digest.
  Add an optional provider capability and session operation that atomically verifies the boundary, durably admits one operation identifier and request digest, returns a runtime-validated result plus current control reference, replays that exact outcome after uncertain transport failures, and rejects changed input without dispatch.

  Keep timeout and abort controls outside the digest-bound turn.
  Extend portable-context conformance to prove exact turn binding, result and control-reference recovery, changed-turn conflict, and zero duplicate continuation effects.

### Patch Changes

- Updated dependencies [cece8b3]
  - @tangle-network/agent-interface@0.42.0

## 0.4.0

### Minor Changes

- 7011e7e: Add provider-neutral durable run references, strictly validated capabilities and replayable event envelopes, scope-bound interaction acknowledgements, request-bound portable context transfer with enforced token limits and provider-confirmed fresh sessions, retry-safe native continuation, and recoverable workspace branching contracts.
  Keep the original SDK adapter interaction method source-compatible and add a separate durable command method.

  Add reusable conformance checks for detached competing-run isolation, every interaction acknowledgement outcome, real over-limit planning, cross-request rejection, context receipts, retry conflicts, continuation boundaries, workspace operation recovery, dependency-ordered cleanup, absent disabled operations, and combined operation/cleanup failures.

  Add exact session and immutable execution control references to detached and reconstructed Tangle sessions, bind result, replay, and cancel to that exact execution, validate capability and Sandbox result data, omit disabled methods, adapt inclusive Sandbox replay to exclusive cursors, reject unproven or mismatched receipts without advancing local state, and fail explicitly for unsupported context inputs.
  Pack and test the Tangle provider together with the interface, testkit, and public Sandbox 0.17.0 dependency.

### Patch Changes

- Updated dependencies [7011e7e]
- Updated dependencies [32acb32]
  - @tangle-network/agent-interface@0.41.0

## 0.3.10

### Patch Changes

- Updated dependencies [886666b]
  - @tangle-network/agent-interface@0.40.0

## 0.3.9

### Patch Changes

- Updated dependencies [7c68070]
- Updated dependencies [dfec816]
  - @tangle-network/agent-interface@0.39.0

## 0.3.8

### Patch Changes

- Updated dependencies [71d3391]
  - @tangle-network/agent-interface@0.38.0

## 0.3.7

### Patch Changes

- Updated dependencies [6ebe9d2]
  - @tangle-network/agent-interface@0.37.0

## 0.3.6

### Patch Changes

- Updated dependencies [c8da041]
  - @tangle-network/agent-interface@0.36.0

## 0.3.5

### Patch Changes

- Updated dependencies [0660698]
- Updated dependencies [87bae75]
  - @tangle-network/agent-interface@0.35.0

## 0.3.4

### Patch Changes

- Republish the checked pnpm artifacts after the failed provider release.

## 0.3.3

### Patch Changes

- 8521060: Publish Core and provider adapters with registry-valid Agent Interface dependencies.

## 0.3.2

### Patch Changes

- Updated dependencies [dc2990e]
- Updated dependencies [9483fb0]
  - @tangle-network/agent-interface@0.34.0

## 0.3.1

### Patch Changes

- Updated dependencies [b24db38]
  - @tangle-network/agent-interface@0.33.0

## 0.3.0

### Minor Changes

- fada902: Define a provider-neutral exact process environment with immutable images, explicit resources, bounded exact-byte files, collision-safe creation, and recoverable shell-free processes with exact terminal reasons.
  Implement provider-secret-free, network-limited execution and recovery for attested Tangle sandboxes, with reusable lifecycle checks for every contract.

### Patch Changes

- Updated dependencies [fada902]
  - @tangle-network/agent-interface@0.32.0

## 0.2.21

### Patch Changes

- Updated dependencies [d8227eb]
  - @tangle-network/agent-interface@0.31.0

## 0.2.20

### Patch Changes

- Updated dependencies [4074c47]
  - @tangle-network/agent-interface@0.30.0

## 0.2.19

### Patch Changes

- a00d0a3: Build only before publishing so installed package artifacts can be repacked with lifecycle scripts enabled.
- Updated dependencies [e1c362e]
- Updated dependencies [a00d0a3]
  - @tangle-network/agent-interface@0.29.0

## 0.2.18

### Patch Changes

- Updated dependencies [f6dfea0]
  - @tangle-network/agent-interface@0.28.0

## 0.2.17

### Patch Changes

- Updated dependencies [d6685fa]
  - @tangle-network/agent-interface@0.27.2

## 0.2.16

### Patch Changes

- Updated dependencies [0103410]
  - @tangle-network/agent-interface@0.27.1

## 0.2.15

### Patch Changes

- Updated dependencies [f10a949]
  - @tangle-network/agent-interface@0.27.0

## 0.2.14

### Patch Changes

- Updated dependencies [8f8d4bb]
  - @tangle-network/agent-interface@0.26.1

## 0.2.13

### Patch Changes

- Updated dependencies [d5d542d]
- Updated dependencies [d5d542d]
  - @tangle-network/agent-interface@0.26.0

## 0.2.12

### Patch Changes

- Updated dependencies [7e34b8c]
- Updated dependencies [a26171f]
- Updated dependencies [1fc1bc7]
  - @tangle-network/agent-interface@0.25.0

## 0.2.11

### Patch Changes

- Updated dependencies [8b2576f]
  - @tangle-network/agent-interface@0.24.0

## 0.2.10

### Patch Changes

- Updated dependencies [bca9ea6]
  - @tangle-network/agent-interface@0.23.0

## 0.2.9

### Patch Changes

- Updated dependencies [73759a5]
- Updated dependencies [96c6e84]
  - @tangle-network/agent-interface@0.22.0

## 0.2.8

### Patch Changes

- Updated dependencies [f5cbf34]
- Updated dependencies [2d70211]
- Updated dependencies [9ad63d0]
  - @tangle-network/agent-interface@0.21.0

## 0.2.7

### Patch Changes

- Updated dependencies [afe552d]
  - @tangle-network/agent-interface@0.20.0

## 0.2.6

### Patch Changes

- Updated dependencies [e0a8e98]
  - @tangle-network/agent-interface@0.19.0

## 0.2.5

### Patch Changes

- Updated dependencies [1f2821b]
  - @tangle-network/agent-interface@0.18.0

## 0.2.4

### Patch Changes

- Updated dependencies [f7ca568]
  - @tangle-network/agent-interface@0.17.1

## 0.2.3

### Patch Changes

- Updated dependencies [175521c]
  - @tangle-network/agent-interface@0.17.0

## 0.2.2

### Patch Changes

- Updated dependencies [dd7c4fe]
  - @tangle-network/agent-interface@0.16.0

## 0.2.1

### Patch Changes

- Updated dependencies [ecd2adc]
  - @tangle-network/agent-interface@0.15.0

## 0.2.0

### Minor Changes

- 6591b16: Add the provider-neutral agent environment contract plus provider packages for Tangle Sandbox, CLI bridge, ComputeSDK, E2B, Daytona, and shared provider conformance tests.

### Patch Changes

- Updated dependencies [6591b16]
  - @tangle-network/agent-interface@0.14.0
