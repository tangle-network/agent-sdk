# @tangle-network/agent-provider-tangle

## 0.14.0

### Minor Changes

- 19e8678: Implement managed Sandbox workspace checkpoint and fork operations with durable recovery, dependency-safe cleanup, and fail-closed TEE attestation verification.

  The Tangle provider now requires `@tangle-network/sandbox` 0.33.1 or newer.

### Patch Changes

- Updated dependencies [19e8678]
  - @tangle-network/agent-interface@1.7.0

## 0.13.3

### Patch Changes

- 99bb7e0: Accept the Sandbox SDK interaction field when an exact result has no pending interaction.

## 0.13.2

### Patch Changes

- 6397cbb: Add `deepFreeze` to `@tangle-network/agent-interface`.
  It owns the rule that a validated value handed to a caller must not be writable afterwards, and it skips a value it has already visited so a self-referring value is frozen once instead of recursing until the stack runs out.

  `snapshotAgentProfile`, `parseCertifiedContext`, the Tangle adapter's capability document, and the Tangle adapter's environment metadata snapshot now call it instead of keeping a private copy each.
  Two of those copies had no such guard and exhausted the stack on a value that referred to itself.

- Updated dependencies [22070e6]
- Updated dependencies [e04c96c]
- Updated dependencies [6397cbb]
- Updated dependencies [655a60f]
- Updated dependencies [a0d7d70]
  - @tangle-network/agent-interface@1.5.0

## 0.13.1

### Patch Changes

- c1ca2fc: Report the `AgentEnvironment.creation` verdict: the Tangle provider maps the platform create receipt, the CLI Bridge provider states `created` for the call that builds the environment handle, and the provider conformance rejects a same-key replay that claims it created the environment.
- Updated dependencies [c1ca2fc]
  - @tangle-network/agent-interface@1.4.0

## 0.13.0

### Minor Changes

- bbc9b2e: Narrow provider interaction capabilities from the Sandbox backend catalog.

## 0.12.3

### Patch Changes

- b594b96: Define and enforce canonical idempotency for generic environment creation.
- Updated dependencies [b594b96]
- Updated dependencies [249611e]
  - @tangle-network/agent-interface@1.0.1

## 0.12.2

### Patch Changes

- Updated dependencies [ca3901d]
  - @tangle-network/agent-interface@1.0.0

## 0.12.1

### Patch Changes

- 09a4304: Reject mismatched or replaced Tangle interactive processes before control, status, or terminal operations.
  Test providers whose launch reserves the first control generation.

## 0.12.0

### Minor Changes

- 5b99d49: Implement the exact Agent Interface 0.56 native interactive session contract.

  Bind sessions to canonical provider receipts, replay-safe control claims, typed prompt and stop commands, and claim-bound terminal mutations.

## 0.11.4

### Patch Changes

- Updated dependencies [4245a0b]
  - @tangle-network/agent-interface@0.56.0

## 0.11.3

### Patch Changes

- Updated dependencies [986ef57]
  - @tangle-network/agent-interface@0.55.0

## 0.11.2

### Patch Changes

- 8537e54: Report a cancelled Tangle run as `cancelled` on the event stream.

  `statusFromSandboxValue` mapped `cancelled` to `failed`, so a caller cancellation
  and a run error reached the consumer as one state. The session status surface
  already keeps them apart, so the same cancellation rendered differently
  depending on which surface a consumer read, and differently again from an
  identically cancelled CLI Bridge run.

  The local `CanonicalStatus` union is replaced by `StreamStatus` from
  `@tangle-network/agent-interface`. The duplicate union is what let the two
  contracts drift: a widening of the shared type could not reach this file.

## 0.11.1

### Patch Changes

- Updated dependencies [d7be4d4]
  - @tangle-network/agent-interface@0.54.0

## 0.11.0

### Minor Changes

- 5ab7e8c: Carry strict per-turn interaction requests from the shared interface to Sandbox backend prompt options.

### Patch Changes

- Updated dependencies [5ab7e8c]
  - @tangle-network/agent-interface@0.53.0

## 0.10.0

### Minor Changes

- e2d6933: Answer an exact interaction through the Tangle provider.

  `respondToInteraction` is offered on a Tangle environment and on a session
  handle. It takes the canonical `InteractionResponseCommand` and returns the
  canonical `InteractionAcknowledgement`, carrying the deployment's own durable
  result: a repeated command reads as `already_resolved_same`, and a different
  answer for a recorded ask reads as `already_resolved_different` with the
  recorded digest named. A refusal is never reported as a success, and a
  response the deployment records without confirming delivery is reported as
  `transport_failure` rather than `accepted`.

  The command carries only the answer the caller supplied. An answer that omits
  a field the outstanding ask requires is refused with that field named, so no
  value is invented for a question the caller did not answer.

  The `interactions` capability is claimed only when the connected deployment
  reports `interactions.responseDedupe`, because the adapter keeps no record of
  its own and every replay answer comes from the deployment. An absent flag, a
  `null` capability document, and an unreadable one all claim nothing.

  The `@tangle-network/sandbox` peer floor moves to `>=0.23.0 <1.0.0`.
  `session.respondToInteraction` first shipped in 0.23.0. The adapter
  feature-detects it, so an older SDK claims no interactions; the floor stands
  because the earlier answer path resolves the session's first outstanding
  question rather than the one a response names, and this adapter never falls
  back to it.

- 18dd3ce: Wire the Tangle provider to the observation and interactive-terminal contracts.

  `environment.observe()` returns the normalized observation over the Sandbox SDK: provider and session identity, lifecycle with its scheduled retirement, the credential-free runtime endpoint, verified placement, requested and effective compute shape, current and peak memory use, the newest execution's token usage and cost, GPU-lease compute billing, and the account plan, credits, quota, and billing period.
  Each surface carries its freshness state, so a value Sandbox does not report is visibly absent instead of arriving as a measured zero.
  Sandbox states no effective CPU or disk, no CPU utilization, and no per-sandbox container compute cost, so those surfaces report `unavailable` with the reason.

  `environment.attachTerminal()` and `environment.terminal()` bind the sandbox terminal WebSocket: attach and reattach, ordered output with an exclusive replay cursor, input, resize, detach, and close, each bound to its parent execution and to a fail-closed expiry.

  Both capability blocks are claimed only where a concrete source backs them, and the create call now sends the compute shape Sandbox reads (`cpuCores`, `memoryMB`, `diskGB`, `accelerator`) instead of passing the contract's field names through unchanged.

  A transport failure never reaches a payload as its own message, because the Sandbox SDK states the request URL there and that URL can carry a credential.
  Each degraded surface names the read that failed and a structured cause: an HTTP status, an error code, or an abort.
  Each surface is also held to its own schema, so one value the contract refuses degrades that surface alone instead of destroying the observation beside it.
  The observation subject names only the provider and the environment id, which both a create handle and a handle rebuilt by id can produce, so the two bind to each other.
  A detached or dropped terminal socket makes its reference unusable, a reattach closes the socket it replaces, and the terminal states the replay cursors it can serve.

### Patch Changes

- 45cb44f: Report a cancelled Tangle run as `cancelled` on the event stream.

  `statusFromSandboxValue` mapped `cancelled` to `failed`, so a caller cancellation
  and a run error reached the consumer as one state. The session status surface
  already keeps them apart, so the same cancellation rendered differently
  depending on which surface a consumer read, and differently again from an
  identically cancelled CLI Bridge run.

  The local `CanonicalStatus` union is replaced by `StreamStatus` from
  `@tangle-network/agent-interface`. The duplicate union is what let the two
  contracts drift: a widening of the shared type could not reach this file.

- 8697c59: Bind a Sandbox event's session identity to the field position that carried it.
  The run-frame position (`data.sessionId`/`data.sessionID`) holds the
  harness-native session id on `session.updated`, so a stream-bound iterator keeps
  it as content and it reaches the normalized event with the frame's title and
  time. The envelope position (`properties`, `properties.info`,
  `properties.part`) holds the runtime session id and is compared to the expected
  session id on every frame, including a `session.updated` frame that fills both
  positions.

  Session-bus frames that carry their session id only inside `properties.part`
  now pass identity binding. A session surface opened without an exact execution
  id reads that bus, and `message.part.updated` puts the id in no other position,
  so every part frame on that lane was refused. The part position is read only on
  a frame type whose part the sidecar rewrites. A `raw` frame carries a backend
  event the sidecar does not shape, so its payload stays opaque to the identity
  read.

  Every check that compares a session id compares each position the frame fills,
  not a single precedence winner. This holds for the expected-session check, for a
  supplied `normalized` block, and for the connection marker of a session stream.

  Scope of the other identity rules this adds, by the shape each applies to:

  - The envelope rule engages on the session bus, which serves envelope frames.
    The run/stream lane and the execution replay lane serve flat run frames, so on
    those lanes the rule refuses only a frame that fills both positions. Neither
    lane emits that shape, so the rule adds no refusal to their current traffic.
  - A frame whose id aliases disagree is refused. Previously the first alias won
    and the rest went unread.
  - A supplied `normalized` block that names a session the frame's own positions
    do not carry is refused. Previously the block was returned unread. The block
    names no field position of its own, so it cannot say which position it
    repeats. A frame whose positions name two sessions therefore supplies no
    block.
  - A frame that omits its executionId or sessionId off an iterator that is not
    stream-bound now reports that absence, rather than reporting the mismatch of a
    value it never carried.

- 18dd3ce: Hold the Tangle terminal to its replay window, its attach result, and its registry lifetime.

  `events()` called with no cursor now starts at the oldest frame the log still retains, resolved when the read begins.
  It previously started at cursor 0, which the log refuses once the bounded buffer has evicted an output frame, so a consumer that held no cursor was locked out of a terminal it had just attached.
  A cursor the consumer names is still refused when its successors were evicted, because the consumer believes it received the frames that gap would drop.

  `attachTerminal()` now reads the ready acknowledgement inside a guard and reports a failed read as `unknown` with the structured cause.
  The Sandbox stream exposes `ready` as an accessor that throws before the runtime acknowledges, so an unguarded read replaced the attach result with a raw transport error and abandoned the socket the attach had opened.
  That error states the request URL, and the URL can carry a credential, so the result names the read and the cause instead.

  A terminal handle now releases its registry entry when it detaches or closes, so a long-lived provider does not retain every terminal it ever attached.
  A handle releases only the entry built on its own socket, so a stale handle cannot evict the terminal a later attach installed.

- Updated dependencies [c4e1978]
- Updated dependencies [18dd3ce]
  - @tangle-network/agent-interface@0.52.0

## 0.9.0

### Minor Changes

- 3cdb9d4: Expose detached environment metadata and preserve a recursively frozen Sandbox metadata snapshot in the Tangle provider.

### Patch Changes

- Updated dependencies [3cdb9d4]
  - @tangle-network/agent-interface@0.51.0

## 0.8.0

### Minor Changes

- bdb076b: Derive retained control from deployment capability discovery, and publish the result on the environment.

  Composing an environment now calls `box.capabilities()` once and takes every deployment-decided claim from that document instead of from the linked Sandbox SDK's method surface.
  The narrowed document is published as `environment.capabilities`, which is the document to read before offering an operation: the operations an environment exposes match it exactly, while `provider.capabilities()` states the adapter's ceiling before any sandbox exists.

  Every flag the capability document carries now gates the claims it backs.
  `streaming.detach` and `streaming.turnIdempotency` need `dispatch.runControlRef` with `dispatch.executionIdOnAdmission`; `streaming.replay` needs `runs.eventReplay`; `sessions.continue`, `retainedControl`, and `session.cancelRun` need those plus `cancel.canonicalRunCancellation`, `cancel.digestBound`, `cancel.idempotent`, and `runs.executionScopedStatus`.
  Detached dispatch also needs a session handle, because a detached run is reachable only through one.

  Four inputs claim nothing: an SDK older than 0.22.0, a sandbox that is not running, a `null` document, and a capability read that fails.
  Such environments omit `dispatch` and `session`.
  A document that leaves a flag unset drops the claims that flag gates and keeps the rest, so it can still carry `streaming.detach` and `streaming.replay`.
  A failed read no longer fails `create()` and no longer deletes the sandbox a cold provision has already paid for; it claims nothing and reports the failure on the warning channel.

### Patch Changes

- Updated dependencies [bdb076b]
  - @tangle-network/agent-interface@0.50.0

## 0.7.3

### Patch Changes

- b4b9f3d: Accept harness-native session identifiers on execution-bound session update events.
  Normalize absent optional Sandbox result fields before strict JSON validation.

## 0.7.2

### Patch Changes

- Updated dependencies [a47e59e]
- Updated dependencies [d93bac3]
  - @tangle-network/agent-interface@0.49.0

## 0.7.1

### Patch Changes

- Updated dependencies [c9856a0]
  - @tangle-network/agent-interface@0.48.0

## 0.7.0

### Minor Changes

- 4346f58: Derive Tangle capability claims from probed facts.

  One narrowing core produces the capability document for the provider and for each sandbox.
  The provider claims retainedControl only when a lazy probe of the linked SDK surface proves dispatchPrompt, session, and cancelRun, and the client exposes get for reconstruction; an unproven client fails closed before any sandbox is created.
  SandboxClientLike documents an optional fetch member: retained control requires an SDK-backed client, and object-spread wrappers lose it.
  Each sandbox narrows the declared document from its own measured facts, so a capable sandbox keeps retained control under a wrapper client.
  Session status bound to an exact control reference reports unknown unless the payload names that execution; queued sessions map to pending.
  Removed: the TanglePromptOptions export (use PromptOptions from @tangle-network/sandbox) and SandboxInstanceLike.checkpoint/fork with the unreachable environment checkpoint and fork methods.
  Requires @tangle-network/sandbox >=0.19.6.

## 0.6.3

### Patch Changes

- 2c93c67: Add retry-safe retained-run cancellation, exact result identity metadata, and capability checks for Sandbox sessions.

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

## 0.5.1

### Patch Changes

- Updated dependencies [d8020a5]
  - @tangle-network/agent-interface@0.45.0

## 0.5.0

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

## 0.4.11

### Patch Changes

- Updated dependencies [682814e]
  - @tangle-network/agent-interface@0.43.1

## 0.4.10

### Patch Changes

- Updated dependencies [7000e82]
  - @tangle-network/agent-interface@0.43.0

## 0.4.9

### Patch Changes

- Updated dependencies [f681bb0]
  - @tangle-network/agent-interface@0.42.1

## 0.4.8

### Patch Changes

- Updated dependencies [cece8b3]
  - @tangle-network/agent-interface@0.42.0

## 0.4.7

### Patch Changes

- 7011e7e: Add provider-neutral durable run references, strictly validated capabilities and replayable event envelopes, scope-bound interaction acknowledgements, request-bound portable context transfer with enforced token limits and provider-confirmed fresh sessions, retry-safe native continuation, and recoverable workspace branching contracts.
  Keep the original SDK adapter interaction method source-compatible and add a separate durable command method.

  Add reusable conformance checks for detached competing-run isolation, every interaction acknowledgement outcome, real over-limit planning, cross-request rejection, context receipts, retry conflicts, continuation boundaries, workspace operation recovery, dependency-ordered cleanup, absent disabled operations, and combined operation/cleanup failures.

  Add exact session and immutable execution control references to detached and reconstructed Tangle sessions, bind result, replay, and cancel to that exact execution, validate capability and Sandbox result data, omit disabled methods, adapt inclusive Sandbox replay to exclusive cursors, reject unproven or mismatched receipts without advancing local state, and fail explicitly for unsupported context inputs.
  Pack and test the Tangle provider together with the interface, testkit, and public Sandbox 0.17.0 dependency.

- Updated dependencies [7011e7e]
- Updated dependencies [32acb32]
  - @tangle-network/agent-interface@0.41.0

## 0.4.6

### Patch Changes

- Updated dependencies [886666b]
  - @tangle-network/agent-interface@0.40.0

## 0.4.5

### Patch Changes

- Updated dependencies [7c68070]
- Updated dependencies [dfec816]
  - @tangle-network/agent-interface@0.39.0

## 0.4.4

### Patch Changes

- Updated dependencies [71d3391]
  - @tangle-network/agent-interface@0.38.0

## 0.4.3

### Patch Changes

- Updated dependencies [6ebe9d2]
  - @tangle-network/agent-interface@0.37.0

## 0.4.2

### Patch Changes

- Updated dependencies [c8da041]
  - @tangle-network/agent-interface@0.36.0

## 0.4.1

### Patch Changes

- Updated dependencies [0660698]
- Updated dependencies [87bae75]
  - @tangle-network/agent-interface@0.35.0

## 0.4.0

### Minor Changes

- dda1a39: Require Sandbox 0.13 and map its session interruption API to agent session cancellation.

## 0.3.5

### Patch Changes

- Accept the Sandbox SDK's file-write receipt while preserving the provider contract's `Promise<void>` write method.

## 0.3.4

### Patch Changes

- 365efe8: Forward environment creation abort signals to the Tangle Sandbox client.

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
