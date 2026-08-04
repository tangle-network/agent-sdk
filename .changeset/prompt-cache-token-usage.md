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
now reads as 80 input + 8,576 cache-read.

**The error flips direction, so callers must be updated, not just re-read.** A
caller that prices `inputTokens` at the full input rate previously OVERCHARGED a
warm call (8,656 × full rate against a true 80 × full + 8,576 × cache rate); it
now UNDERCHARGES, because the 8,576 cache-read tokens are no longer in the field
it prices and it does not yet charge for them anywhere. Correct usage is to
price all three terms:

    cost = inputTokens × inputRate
         + cacheReadTokens × cacheReadRate
         + cacheWriteTokens × cacheWriteRate

and to use `promptTokens(usage)` — never `inputTokens` — wherever the number
means "context size".

`genAiUsageAttributes` emits `gen_ai.usage.cache_read_input_tokens` and
`gen_ai.usage.cache_creation_input_tokens` beside `gen_ai.usage.input_tokens`,
so total prompt volume stays recoverable on the attribute bag rather than being
silently under-reported once `input_tokens` narrows to the billed tail. Both are
omitted entirely for a producer that reported no cache information, because a
synthesized `0` would read as "measured, no cache".

The reader normalizes two provider conventions that reach callers through the
same endpoint — OpenAI-style, where the cached count is *inside* the reported
prompt total, and Anthropic-style, where it sits beside it — and does not
double-count the router's normalized `prompt_cache` echo of a provider-native
counter.
