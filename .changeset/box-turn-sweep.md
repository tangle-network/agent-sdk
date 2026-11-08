---
"@tangle-network/agent-provider-cli-bridge": patch
"@tangle-network/agent-provider-testkit": patch
---

Every turn now restores the box's process set: the provider snapshots `/proc` before a turn and sweeps any pid the turn left behind after the stream settles, so timing-out and aborted turns no longer leak detached tool children (opencode's Bash tool spawns them detached) into later checks. The testkit accepts opencode's per-turn config files as ephemeral when the axis that proves them (deny, subagent, system) ran green.
