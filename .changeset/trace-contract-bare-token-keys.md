---
"@tangle-network/agent-trace-contract": patch
---

`INPUT_TOKEN_ATTR_KEYS` and `OUTPUT_TOKEN_ATTR_KEYS` now accept the bare `input_tokens`/`output_tokens` keys, lowest priority, last in each list. Claude Code's native OTel capture (`claude_code.llm_request`) writes only these bare keys; the cache-read and cache-write lists already accepted their bare equivalents, but a Claude Code native trace read 0 input and 0 output tokens with non-zero cache counts. Safe now that token counts alone never decide a span's kind (see the token-counts-are-not-a-kind changeset).
