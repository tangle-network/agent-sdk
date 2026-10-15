---
"@tangle-network/agent-interface": minor
---

Let claude-code and codex run any router-served model. The Tangle Router passes only a vendor's own models through its Anthropic Messages and OpenAI Responses wires and translates every other model to chat completions, so those two harnesses no longer carry a provider lock: `harnessModelSupport("claude-code", "zai/glm-5.3")` and `harnessModelSupport("codex", "google/gemini-2.5-flash-lite")` are supported, and `harnessProviders` returns `null` for both. `kimi-code` stays locked to Moonshot. A vendor's model still adopts its native harness when the caller names none (`preferredHarnessForModel`, and `snapHarnessToModel` from a locked harness); `snapModelToHarness` no longer ranks Anthropic or OpenAI ids for claude-code and codex because they never snap.
