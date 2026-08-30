# @tangle-network/agent-provider-cli-bridge

## 0.11.2

### Patch Changes

- Refresh release evidence against the current Bridge and Sandbox control contracts.
- Updated dependencies
  - @tangle-network/agent-interface@1.9.1

## 0.11.1

### Patch Changes

- a8c09d0: Bound retained result events while preserving complete text and usage totals.

## 0.11.0

### Minor Changes

- 1b7c003: Add provider-owned, retry-safe portable context transfer for exact fresh sessions.
  
  Allow an accepted destination contract to select its exact environment identifier.

### Patch Changes

- Updated dependencies [1b7c003]
  - @tangle-network/agent-interface@1.9.0

## 0.10.0

### Minor Changes

- 069e9cd: Expose the exact continued run after durable admission and before terminal output.

  The CLI Bridge provider can now hand control to runtimes before it waits for the continued turn to finish.

### Patch Changes

- Updated dependencies [069e9cd]
  - @tangle-network/agent-interface@1.8.0

## 0.9.6

### Patch Changes

- 655a60f: Add `sameAgentRunControlRef` to `@tangle-network/agent-interface`.
  It owns the question "do these two references name the same run", and answers it over the reference's canonical form rather than a list of field names, so a reference that gains a coordinate is compared on it without a caller having to remember.

  The two cancellation and control acknowledgement matchers and the cli-bridge adapter's retained control and native continuation checks now call it instead of comparing by hand.

- Updated dependencies [22070e6]
- Updated dependencies [e04c96c]
- Updated dependencies [6397cbb]
- Updated dependencies [655a60f]
- Updated dependencies [a0d7d70]
  - @tangle-network/agent-interface@1.5.0

## 0.9.5

### Patch Changes

- 07cc02e: State which call can add a turn to a reconstructed environment.
  The README carries the two-tier continuation rule, one refusal replaces three near-copies of the same rule, and the message names `session.continueNative` and the capability it needs.
  The contract test covers the `already_resolved_different`, `already_resolved_same`, and `cancelled` interaction acknowledgements against the real Bridge.
- c1ca2fc: Report the `AgentEnvironment.creation` verdict: the Tangle provider maps the platform create receipt, the CLI Bridge provider states `created` for the call that builds the environment handle, and the provider conformance rejects a same-key replay that claims it created the environment.
- Updated dependencies [c1ca2fc]
  - @tangle-network/agent-interface@1.4.0

## 0.9.4

### Patch Changes

- fdb69bc: Expose cli-bridge execution options, including host jail settings, through `CliBridgeProviderOptions` and forward them unchanged.

## 0.9.3

### Patch Changes

- 8ad10d4: Exclude reasoning parts from retained assistant result text.

## 0.9.2

### Patch Changes

- 218203f: Bind retained dispatch, status, replay, result, and cancellation to the complete run identity.
  Expose exact run lookup for recovery after a caller loses the dispatch response.

## 0.9.1

### Patch Changes

- 48656f3: Advertise generic retained run control for every CLI Bridge harness route.
  Keep native context continuation and permission interactions limited to Pi, where the adapter implements those protocols.

## 0.9.0

### Minor Changes

- 2cd50ba: Implement Agent Interface native context boundary reads and retry-safe same-session continuation through CLI Bridge.

## 0.8.1

### Patch Changes

- ca6e7e9: Accept Runtime's detached dispatch control on native retained turns.

  The provider keeps this local control out of the CLI Bridge request body.
  Direct streamed turns still reject detached execution.

## 0.8.0

### Minor Changes

- d3abf3e: Route retry-safe retained Pi interaction turns through cli-bridge's native session API, preserve exact replay bindings, and expose idempotent permission responses through the Agent Environment interaction contract.
  Discover the complete interaction contract from the exact running Bridge model route before enabling native control.
  Retain the selected harness and model route inside the opaque environment identifier for safe process restart.
  Bind the canonical create digest into that identifier and keep native turns on the discovered model route.
  Reject caller-owned plain identifiers so reconnection cannot silently select another route.
  Validate terminal events and cancellation snapshots before exposing their effects.
  Clean compiled output before each build and keep source tests separate from generated files.

## 0.7.8

### Patch Changes

- 32e7341: Decode retained canonical runtime events with exact run, event, sequence, and replay identities.
  Make every emitted event id valid as the next exclusive replay cursor.
  Keep legacy OpenAI chunk streams and reject malformed or mixed stream formats.

## 0.7.7

### Patch Changes

- b594b96: Define and enforce canonical idempotency for generic environment creation.
- Updated dependencies [b594b96]
- Updated dependencies [249611e]
  - @tangle-network/agent-interface@1.0.1

## 0.7.6

### Patch Changes

- Updated dependencies [ca3901d]
  - @tangle-network/agent-interface@1.0.0

## 0.7.5

### Patch Changes

- Updated dependencies [4245a0b]
  - @tangle-network/agent-interface@0.56.0

## 0.7.4

### Patch Changes

- Updated dependencies [986ef57]
  - @tangle-network/agent-interface@0.55.0

## 0.7.3

### Patch Changes

- Updated dependencies [d7be4d4]
  - @tangle-network/agent-interface@0.54.0

## 0.7.2

### Patch Changes

- Updated dependencies [5ab7e8c]
  - @tangle-network/agent-interface@0.53.0

## 0.7.1

### Patch Changes

- 2da20c6: Make retained CLI Bridge state authoritative for completion, cancellation, and replay.
  Reject aggregate responses that do not match the accepted run identity.
  Read cancelled retained state when a stream ends with only its protocol marker.
  Consume rejected aggregate responses before returning identity errors.

## 0.7.0

### Minor Changes

- 18dd3ce: Add the normalized environment observation to the cli-bridge provider.

  `environment.observe()` reports provider identity, the credential-free bridge endpoint, and the token usage and cost of the newest execution the handle measured.
  cli-bridge never probes the bridge, so the configured execution kind is carried as the requested placement, and the verified placement and the lifecycle of a live handle state `unavailable` with that reason.
  A destroyed handle reports a stopped lifecycle, because the adapter performed the destroy.
  The usage of one run is summed across its events and attributed to that run's execution id.
  cli-bridge provisions no compute and holds no account, so the compute shape, resource use, compute cost, and account surfaces are never claimed and always carry `unavailable` with the reason.
  The observation surface is offered only where the provider document claims it, and the endpoint claim is cleared when the base URL states no reachable host.

### Patch Changes

- c4e1978: Preserve caller cancellation from retained CLI Bridge SSE terminal events as a cancelled run state.
- Updated dependencies [c4e1978]
- Updated dependencies [18dd3ce]
  - @tangle-network/agent-interface@0.52.0

## 0.6.4

### Patch Changes

- Updated dependencies [3cdb9d4]
  - @tangle-network/agent-interface@0.51.0

## 0.6.3

### Patch Changes

- Updated dependencies [bdb076b]
  - @tangle-network/agent-interface@0.50.0

## 0.6.2

### Patch Changes

- Updated dependencies [a47e59e]
- Updated dependencies [d93bac3]
  - @tangle-network/agent-interface@0.49.0

## 0.6.1

### Patch Changes

- 7601435: Bump `undici` from 7.28.0 to 7.29.0 to clear GHSA-4cwx-7wf7-3272 (high) and four
  moderate advisories, all fixed at undici >=7.29.0.

  `undici` is declared through the workspace catalog, and this package is the only
  catalog consumer. The cleared advisories are:

  - GHSA-4cwx-7wf7-3272 (high) — cross-user information disclosure and parse-time
    crash via degenerate private cache directives.
  - GHSA-8xcm-r25x-g524 (moderate) — downstream response desynchronization via the
    retry interceptor.
  - GHSA-m8rv-5g2x-5cg5 (moderate) — CRLF injection via a blob-like body `type`
    property.
  - GHSA-jr45-8vmc-qm54 (moderate) — cross-user information disclosure via
    whitespace around equals in `Cache-Control` directives.
  - GHSA-v3r7-h72x-cjcm (moderate) — cookie attribute injection via an unsanitized
    domain and unparsed `setCookie` fields.

  The provider imports only `Agent` and `fetch` from `undici` in `transport.ts`.
  Both stay unchanged across the 7.x line, so 7.29.0 is a drop-in minor bump with
  no API change.

- Updated dependencies [c9856a0]
  - @tangle-network/agent-interface@0.48.0

## 0.6.0

### Minor Changes

- 8fd0d63: Add exact retained-run dispatch, restart reconstruction, event replay, continuation, cancellation, and model-request telemetry.

  Split transport, wire parsing, retained state, control, streaming, execution, and environment ownership into focused modules.

## 0.5.0

### Minor Changes

- facff5c: Expose cli-bridge durable runs through `AgentEnvironment.dispatch()` and `AgentEnvironment.session()` with exact identity, cursor replay, usage-preserving results, continuation, and terminal-confirmed cancellation.

### Patch Changes

- facff5c: Keep the task message separate from the exact `AgentProfile`, and forward the profile's reasoning effort to cli-bridge.
- Updated dependencies [facff5c]
- Updated dependencies [facff5c]
  - @tangle-network/agent-interface@0.47.0

## 0.4.3

### Patch Changes

- Updated dependencies [077635f]
  - @tangle-network/agent-interface@0.46.1

## 0.4.2

### Patch Changes

- Updated dependencies [b44d502]
- Updated dependencies [d27deb9]
  - @tangle-network/agent-interface@0.46.0

## 0.4.1

### Patch Changes

- Updated dependencies [d8020a5]
  - @tangle-network/agent-interface@0.45.0

## 0.4.0

### Minor Changes

- 3bbafd2: Separate replacing the harness's system prompt from adding to it.

  `AgentProfilePrompt.systemPrompt` was documented as full replacement but reached most harnesses as an addition — `agent-provider-cli-bridge` pushes it as a leading `role: "system"` message on top of the harness's own prompt, and claude-code folds it into `--append-system-prompt`. Only harnesses with a real replacement control (`pi --system-prompt` with context files, skills, and templates off; gemini `.gemini/system.md`) delete the built-in prompt. One field carried two opposite meanings and nothing reported which one a caller got, so a profile written to remove the harness's instructions silently ran with them still in force.

  Add `AgentProfilePrompt.appendSystemPrompt` for the additive intent, distinct from both `systemPrompt` (replacement) and `instructions` (the lower-privilege project-instruction surface). Setting replacement and addition together is legal and ordered — the addition composes on top of the replacement — because `mergeAgentProfiles` composes the two fields independently, and refusing the pair would let two valid profiles merge into an invalid one. Additive text now concatenates on merge rather than overwriting, so an overlay cannot silently delete what a base added.

  Change `AgentProfileCapabilities.systemPrompt` from `boolean` to `{ replace: boolean; append: boolean }`, both required. A backend that can only add text declares `replace: false` and must refuse a profile carrying `systemPrompt` instead of appending it. The object is required rather than an added optional flag so every declaration site is a compile error and every capability document still carrying the bare boolean fails validation, rather than being read as "replacement supported" — which for every append-only backend is false.

  Carry the split through the rest of the contract: `appendSystemPrompt` is the thirtieth canonical materialization leaf at `/prompt/appendSystemPrompt`, `AgentProfilePromptRemoval` can remove either intent alone, and `AgentCandidateProfilePlanMaterial` records the added prompt separately from the replacement so the same bytes under the two intents are two different plan identities.

  Declare the measured bits at every provider, from the harness rather than from the wire. `harnessSystemPromptIntents(harness)` joins the harness capability layer as the single measured table: claude-code and pi own both intents, codex and gemini own replacement only, opencode owns addition only, and every other harness owns neither — including the ones whose prompt path is a `role: "system"` chat message, which is flattened into the user turn before the CLI sees it. `defaultCliBridgeCapabilities(harness?)` and `defaultTangleSandboxCapabilities(harness?)` now read that table; both adapters forward the profile to a layer that picks the harness, so an unnamed harness declares `{ replace: false, append: false }` rather than promising what it cannot check. Declaring from expressibility was the failure this replaces — a caller reading `replace: true` from the tangle adapter and running an opencode sandbox got a refusal. daytona, e2b, and computesdk materialize no profile prompt and keep `{ replace: false, append: false }`.

  `harnessSystemPromptIntents` answers for a plan-forwarding executor, and now says so. Both callers lower a profile to files, env vars, and flags and hand the result to a launcher they do not own, so the harness alone decides what they can promise. One control in the table does not fit that shape: opencode's `agent.<name>.prompt` really does replace its built-in prompt, but it binds to the single agent whoever starts the server selects, which a plan cannot name — so `opencode` reads `replace: false` here while an executor that writes opencode's server config and picks the primary agent honors replacement and declares `replace: true` for itself. The table stays harness-keyed rather than widening: a `true` there would promise the intent to every plan-forwarding caller, and none of them can deliver it. An executor that owns a launcher control states that where it binds it.

  Stop `agent-provider-cli-bridge` synthesizing a `role: "system"` message from `prompt.systemPrompt`. It lowered the replacement intent as an addition — the defect this release exists to remove — and, since the same request also carries `agent_profile`, the bridge rejected it outright for mixing system-role messages with a profile. Both intents now travel only on `agent_profile`, where the bridge binds each to the control its harness owns or refuses it.

### Patch Changes

- Updated dependencies [3bbafd2]
  - @tangle-network/agent-interface@0.44.0

## 0.3.5

### Patch Changes

- Updated dependencies [682814e]
  - @tangle-network/agent-interface@0.43.1

## 0.3.4

### Patch Changes

- Updated dependencies [7000e82]
  - @tangle-network/agent-interface@0.43.0

## 0.3.3

### Patch Changes

- Updated dependencies [f681bb0]
  - @tangle-network/agent-interface@0.42.1

## 0.3.2

### Patch Changes

- Updated dependencies [cece8b3]
  - @tangle-network/agent-interface@0.42.0

## 0.3.1

### Patch Changes

- Updated dependencies [7011e7e]
- Updated dependencies [32acb32]
  - @tangle-network/agent-interface@0.41.0

## 0.3.0

### Minor Changes

- b5e6e1b: Make CLI bridge turns resumable, idempotent, and cancellation-safe using server-owned run state, and derive bridge selection from run data.

### Patch Changes

- Updated dependencies [886666b]
  - @tangle-network/agent-interface@0.40.0

## 0.2.33

### Patch Changes

- Updated dependencies [7c68070]
- Updated dependencies [dfec816]
  - @tangle-network/agent-interface@0.39.0

## 0.2.32

### Patch Changes

- Updated dependencies [71d3391]
  - @tangle-network/agent-interface@0.38.0

## 0.2.31

### Patch Changes

- Updated dependencies [6ebe9d2]
  - @tangle-network/agent-interface@0.37.0

## 0.2.30

### Patch Changes

- Updated dependencies [c8da041]
  - @tangle-network/agent-interface@0.36.0

## 0.2.29

### Patch Changes

- Updated dependencies [0660698]
- Updated dependencies [87bae75]
  - @tangle-network/agent-interface@0.35.0

## 0.2.28

### Patch Changes

- 1ca3978: Disable response-header and body-idle timeouts by default, reuse connections across turns, and close provider resources with the environment.

## 0.2.27

### Patch Changes

- 02c966a: Emit canonical text and tool-call events, report usage once, and fail when the bridge stream errors or ends without a terminal result.

## 0.2.26

### Patch Changes

- Republish the checked pnpm artifacts after the failed provider release.

## 0.2.25

### Patch Changes

- 8521060: Publish Core and provider adapters with registry-valid Agent Interface dependencies.

## 0.2.24

### Patch Changes

- Updated dependencies [dc2990e]
- Updated dependencies [9483fb0]
  - @tangle-network/agent-interface@0.34.0

## 0.2.23

### Patch Changes

- Updated dependencies [b24db38]
  - @tangle-network/agent-interface@0.33.0

## 0.2.22

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
