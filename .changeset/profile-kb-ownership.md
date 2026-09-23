---
"@tangle-network/agent-interface": minor
---

Profile guidance composition now replaces only the block sources it owns. `composeAgentProfileGuidance` takes `replaceSources` (default: the sources being composed), and `withProfileKb` owns `harness`, `model`, and `learning` (`PROFILE_KB_SOURCES`), so a team's own guidance layer and blocks a user wrote survive recomposition. The knowledge base adds GPT-6 Astra, Sol, and Luna, which Codex 0.156.1 serves; records Codex 0.156.1, OpenCode 1.18.32, Pi 0.87.1, and Kimi Code 2.0.2; lists the router surface only where a dated router check served the id; and drops a comparative line from Claude Haiku 4.5.
