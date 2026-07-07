---
"@tangle-network/agent-interface": minor
---

Add optional `AgentProfile.harness` — a typed, executor-overridable preferred execution harness (`HarnessType`). Formalizes the `profile.harness` runtimes already read untyped; identity stays harness-agnostic (the leaderboard `harness × model` axis and per-worker supervisor routing still override it), and it becomes a first-class lever an improvement loop can optimize.
