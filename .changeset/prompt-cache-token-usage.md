---
"@tangle-network/agent-core": minor
---

Carry prompt-cache tokens through `readTokenUsage` instead of discarding them.

`TokenUsageCounts` gains `cacheReadTokens` and `cacheWriteTokens`, and the three
prompt-side fields are now disjoint and additive: `inputTokens` is the freshly
billed tail, and `inputTokens + cacheReadTokens + cacheWriteTokens` is the size
of the prompt the model saw. Two helpers expose that directly — `promptTokens()`
and `cacheHitRate()`.

**Behavior change on an existing field.** For OpenAI-compatible payloads,
`inputTokens` previously returned the reported `prompt_tokens`, which already
includes the cached share; it now excludes it, so a warm call's `inputTokens`
drops to the part actually billed at the input rate. Measured on
router.tangle.tools with `glm-5.2`, one append-only turn:
`prompt_tokens=8656, cached_tokens=8576` used to read as 8,656 input tokens and
now reads as 80 input + 8,576 cache-read. Callers that priced `inputTokens` at
the full input rate were overcharging warm calls by the cached share; callers
that read `inputTokens` as context size were understating it by the same amount
on providers that report the tail only.

The reader normalizes two provider conventions that reach callers through the
same endpoint — OpenAI-style, where the cached count is *inside* the reported
prompt total, and Anthropic-style, where it sits beside it — and does not
double-count the router's normalized `prompt_cache` echo of a provider-native
counter.
