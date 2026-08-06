---
"@tangle-network/agent-interface": minor
---

Add `prime` (PrimeIntellect prime-agent, the RLM fork of the pi line) to the canonical harness enum, with its reasoning-effort set (`none…ultracode`, mapping to the fork's `--thinking off…max`) and system-prompt controls (`replace` + `append`). `prime` is router-backed: no provider lock. It is deliberately distinct from `pi` — the fork's wire protocol has diverged and its daemon rejects pi-line clients.
