---
"@tangle-network/agent-provider-cli-bridge": patch
"@tangle-network/agent-provider-testkit": patch
---

The box carries opencode and codex, each routed through the Router: opencode by an ambient `OPENCODE_CONFIG_CONTENT` provider table built from the registry's `MANAGED_MODEL_LADDER`, codex by `CODEX_TANGLE_ROUTER_URL`, which the pinned CLI Bridge turns into a `model_providers` entry pointing at the Router's responses wire. The live suite proves where a codex turn dials by pointing the provider at a key-rejecting listener inside the box and asserting the captured request. The live suite declares a probe axis only when the provider claims it, and the provider's capability document lowers the hooks, permissions and subagents axes to what the pinned planner actually supports for the harness (opencode hooks; codex permissions and subagents), so those probes are skipped instead of failing create.
