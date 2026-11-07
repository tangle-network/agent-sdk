---
"@tangle-network/agent-provider-cli-bridge": patch
"@tangle-network/agent-provider-testkit": patch
---

The box carries opencode, routed through the Router by an ambient `OPENCODE_CONFIG_CONTENT` provider table built from the registry's `MANAGED_MODEL_LADDER`. codex is a `BOX_EXCLUSIONS` row: CLI Bridge never writes codex's config-only endpoint, so a box turn reached api.openai.com instead of the Router. The live suite attaches its probe hook only when the provider declares hooks, so a harness whose planner cannot lower command hooks (opencode) runs every other check instead of failing create.
