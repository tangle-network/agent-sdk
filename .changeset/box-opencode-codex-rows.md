---
"@tangle-network/agent-provider-cli-bridge": patch
"@tangle-network/agent-provider-testkit": patch
---

The box carries opencode and codex, each routed through the Router: opencode by an ambient `OPENCODE_CONFIG_CONTENT` provider table built from the registry's `MANAGED_MODEL_LADDER`, codex by `CODEX_TANGLE_ROUTER_URL`, which the pinned CLI Bridge turns into a `model_providers` entry pointing at the Router's chat wire. The live suite proves where a codex turn dials by pointing the provider at a key-rejecting listener inside the box and asserting the captured request. The live suite attaches its probe hook only when the provider declares hooks, so a harness whose planner cannot lower command hooks (opencode) runs every other check instead of failing create.
