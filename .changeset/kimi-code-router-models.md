---
"@tangle-network/agent-interface": minor
---

Kimi Code runs any Router model. A managed Kimi Code box writes an `openai_legacy` provider that sends chat completions to the Router, so `harnessModelSupport("kimi-code", "zai/glm-5.3")` is supported instead of refused as "runs only moonshot models". A caller's own Kimi login stays limited to Moonshot models, as a vendor login is for Claude Code and Codex.
