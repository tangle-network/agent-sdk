# @tangle-network/agent-provider-daytona

## 0.3.6

### Patch Changes

- Updated dependencies [a47e59e]
- Updated dependencies [d93bac3]
  - @tangle-network/agent-interface@0.49.0

## 0.3.5

### Patch Changes

- Updated dependencies [c9856a0]
  - @tangle-network/agent-interface@0.48.0

## 0.3.4

### Patch Changes

- Updated dependencies [facff5c]
- Updated dependencies [facff5c]
  - @tangle-network/agent-interface@0.47.0

## 0.3.3

### Patch Changes

- Updated dependencies [077635f]
  - @tangle-network/agent-interface@0.46.1

## 0.3.2

### Patch Changes

- Updated dependencies [b44d502]
- Updated dependencies [d27deb9]
  - @tangle-network/agent-interface@0.46.0

## 0.3.1

### Patch Changes

- Updated dependencies [d8020a5]
  - @tangle-network/agent-interface@0.45.0

## 0.3.0

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

## 0.2.37

### Patch Changes

- Updated dependencies [682814e]
  - @tangle-network/agent-interface@0.43.1

## 0.2.36

### Patch Changes

- Updated dependencies [7000e82]
  - @tangle-network/agent-interface@0.43.0

## 0.2.35

### Patch Changes

- Updated dependencies [f681bb0]
  - @tangle-network/agent-interface@0.42.1

## 0.2.34

### Patch Changes

- Updated dependencies [cece8b3]
  - @tangle-network/agent-interface@0.42.0

## 0.2.33

### Patch Changes

- Updated dependencies [7011e7e]
- Updated dependencies [32acb32]
  - @tangle-network/agent-interface@0.41.0

## 0.2.32

### Patch Changes

- Updated dependencies [886666b]
  - @tangle-network/agent-interface@0.40.0

## 0.2.31

### Patch Changes

- Updated dependencies [7c68070]
- Updated dependencies [dfec816]
  - @tangle-network/agent-interface@0.39.0

## 0.2.30

### Patch Changes

- Updated dependencies [71d3391]
  - @tangle-network/agent-interface@0.38.0

## 0.2.29

### Patch Changes

- Updated dependencies [6ebe9d2]
  - @tangle-network/agent-interface@0.37.0

## 0.2.28

### Patch Changes

- Updated dependencies [c8da041]
  - @tangle-network/agent-interface@0.36.0

## 0.2.27

### Patch Changes

- Updated dependencies [0660698]
- Updated dependencies [87bae75]
  - @tangle-network/agent-interface@0.35.0

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
