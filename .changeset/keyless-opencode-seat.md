---
"@tangle-network/agent-interface": patch
---

An `AgentProfile.seats` stage can name OpenCode's keyless free route: `opencode/opencode/glm-5.3-flash-free` (and `opencode/opencode/deepseek-v4.1-flash-free`) is valid as a pool stage or the first stage. The profile knowledge base names both routes, and the profile seat check and `parseSeatSpec` now share one rule, `providerServesModel(provider, model)`: a provider serves its own model family, a provider/model spelling the knowledge base lists, or any model outside every known family. `parseSeatSpec` now refuses an explicit provider that cannot serve the model (`opencode/anthropic/glm-5.3`), as the schema already did. The unreachable vendor-lock branch of `harnessModelSupport` and its `allowedProviders` field are removed; `harnessProviders` returns `null` for every harness, as it already did.
