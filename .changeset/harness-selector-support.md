---
"@tangle-network/agent-interface": minor
---

Add harness selector-support capability: `harnessHonorsModel`, `harnessHonorsEffort`, and
`harnessHonorsSelectors`. These report whether a harness's runner actually honors the per-turn model
and reasoning-effort pickers (grounded in the cli-bridge adapter audit: `amp` drops both;
`openclaw`/`nanoclaw` drop the model; `factory-droids`/`hermes`/`nanoclaw` drop the effort). Chat
pickers use these to trim or mark harnesses up front, so a user's model/effort choice is never
silently ignored. Distinct from `reasoningEffortsFor` (which levels a harness can express).
