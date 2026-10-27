---
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-e2b": patch
"@tangle-network/agent-provider-daytona": patch
"@tangle-network/agent-provider-computesdk": patch
"@tangle-network/agent-core": patch
"@tangle-network/agent-provider-testkit": patch
"@tangle-network/agent-provider-cli-bridge": patch
---

Raise the `@tangle-network/agent-interface` floor to `^5.10.2` (bounded profile admission, Zod 54404), so an install whose lock still holds an earlier Interface fails instead of resolving silently.
