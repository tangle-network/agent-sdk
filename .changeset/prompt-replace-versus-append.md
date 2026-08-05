---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-cli-bridge": minor
"@tangle-network/agent-provider-computesdk": minor
"@tangle-network/agent-provider-daytona": minor
"@tangle-network/agent-provider-e2b": minor
"@tangle-network/agent-provider-tangle": minor
---

Separate replacing the harness's system prompt from adding to it.

`AgentProfilePrompt.systemPrompt` was documented as full replacement but reached most harnesses as an addition — `agent-provider-cli-bridge` pushes it as a leading `role: "system"` message on top of the harness's own prompt, and claude-code folds it into `--append-system-prompt`. Only harnesses with a real replacement control (`pi --system-prompt` with context files, skills, and templates off; gemini `.gemini/system.md`) delete the built-in prompt. One field carried two opposite meanings and nothing reported which one a caller got, so a profile written to remove the harness's instructions silently ran with them still in force.

Add `AgentProfilePrompt.appendSystemPrompt` for the additive intent, distinct from both `systemPrompt` (replacement) and `instructions` (the lower-privilege project-instruction surface). Setting replacement and addition together is legal and ordered — the addition composes on top of the replacement — because `mergeAgentProfiles` composes the two fields independently, and refusing the pair would let two valid profiles merge into an invalid one. Additive text now concatenates on merge rather than overwriting, so an overlay cannot silently delete what a base added.

Change `AgentProfileCapabilities.systemPrompt` from `boolean` to `{ replace: boolean; append: boolean }`, both required. A backend that can only add text declares `replace: false` and must refuse a profile carrying `systemPrompt` instead of appending it. The object is required rather than an added optional flag so every declaration site is a compile error and every capability document still carrying the bare boolean fails validation, rather than being read as "replacement supported" — which for every append-only backend is false.

Carry the split through the rest of the contract: `appendSystemPrompt` is the thirtieth canonical materialization leaf at `/prompt/appendSystemPrompt`, `AgentProfilePromptRemoval` can remove either intent alone, and `AgentCandidateProfilePlanMaterial` records the added prompt separately from the replacement so the same bytes under the two intents are two different plan identities.

Declare the measured bits at every provider, from the harness rather than from the wire. `harnessSystemPromptIntents(harness)` joins the harness capability layer as the single measured table: claude-code and pi own both intents, codex and gemini own replacement only, opencode owns addition only, and every other harness owns neither — including the ones whose prompt path is a `role: "system"` chat message, which is flattened into the user turn before the CLI sees it. `defaultCliBridgeCapabilities(harness?)` and `defaultTangleSandboxCapabilities(harness?)` now read that table; both adapters forward the profile to a layer that picks the harness, so an unnamed harness declares `{ replace: false, append: false }` rather than promising what it cannot check. Declaring from expressibility was the failure this replaces — a caller reading `replace: true` from the tangle adapter and running an opencode sandbox got a refusal. daytona, e2b, and computesdk materialize no profile prompt and keep `{ replace: false, append: false }`.

Stop `agent-provider-cli-bridge` synthesizing a `role: "system"` message from `prompt.systemPrompt`. It lowered the replacement intent as an addition — the defect this release exists to remove — and, since the same request also carries `agent_profile`, the bridge rejected it outright for mixing system-role messages with a profile. Both intents now travel only on `agent_profile`, where the bridge binds each to the control its harness owns or refuses it.
