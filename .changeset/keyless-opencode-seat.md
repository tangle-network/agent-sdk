---
"@tangle-network/agent-interface": patch
---

An `AgentProfile.seats` stage can name OpenCode's keyless free route: harness `opencode`, provider `opencode`, model `glm-5.3-flash-free` (or `deepseek-v4.1-flash-free`) is valid as a pool stage or the first stage, matching what `parseSeatSpec('opencode/opencode/glm-5.3-flash-free')` already accepted. The profile knowledge base names both routes, cited to OpenCode's own model catalog. A stage still fails when its model belongs to another provider's family and the knowledge base lists no such spelling (provider `anthropic` with `glm-5.3-flash-free`); a model outside every family (`big-pickle`) is now left to its provider, as `harnessModelSupport` already leaves it to the harness. The unreachable vendor-lock branch of `harnessModelSupport` and its `allowedProviders` field are removed; `harnessProviders` returns `null` for every harness, as it already did.
