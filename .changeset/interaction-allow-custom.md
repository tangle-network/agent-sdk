---
"@tangle-network/agent-interface": minor
---

Add `allowCustom` to select interaction fields: when set, `validateInteractionAnswer` accepts non-blank write-in values beyond the declared options, and `questionAnswerSpec` propagates the flag from `LegacyQuestion.allowCustom`. Enables "Other…" style questions where the user supplies their own text as the answer value.
