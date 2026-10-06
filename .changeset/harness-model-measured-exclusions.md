---
"@tangle-network/agent-interface": minor
---

Resolve bare catalog model ids through their provider family before the harness provider lock applies, so claude-code no longer accepts glm-5.3. Add harnessModelSupport, which returns the refusal message, and harnessModelExclusions, the pi pairs measured to fail on production on 2026-10-05 (Anthropic models and GPT-5.6 Luna with a reasoning effort, Gemini 3.8 Flash always). harnessSupportsModel accepts the run reasoning effort.
