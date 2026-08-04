import { describe, expect, it } from "vitest";
import {
  addTokenUsage,
  cacheHitRate,
  promptTokens,
  readTokenUsage,
  TOKEN_USAGE_CACHE_READ_EXCLUSIVE_KEYS,
  TOKEN_USAGE_CACHE_READ_INCLUSIVE_KEYS,
  TOKEN_USAGE_CACHE_WRITE_EXCLUSIVE_KEYS,
  TOKEN_USAGE_CACHE_WRITE_INCLUSIVE_KEYS,
  TOKEN_USAGE_DETAIL_KEYS,
} from "../src/index.js";

/**
 * The payloads below are VERBATIM `usage` bags captured from
 * router.tangle.tools on 2026-08-03, one append-only 4-turn conversation per
 * provider, same request shape. They are the ground truth this reader exists to
 * get right, so they are pinned rather than paraphrased.
 */

// glm-5.2 (provider `zai`), turn 2 of 4. OpenAI-compatible convention:
// `prompt_tokens` is the WHOLE prompt. Proof inside the payload itself:
// prompt_tokens(8656) + completion_tokens(42) === total_tokens(8698).
const ZAI_TURN_2 = {
  completion_tokens: 42,
  completion_tokens_details: { reasoning_tokens: 33 },
  prompt_tokens: 8656,
  prompt_tokens_details: { cached_tokens: 8576 },
  total_tokens: 8698,
  prompt_cache: {
    enabled: true,
    status: "read",
    provider: "zai",
    read_tokens: 8576,
    write_tokens: 0,
  },
} as const;

// Anthropic-native convention reaching the caller through the SAME
// OpenAI-compatible endpoint: `prompt_tokens` is only the uncached tail.
// Proof inside the payload: prompt_tokens(39) + completion_tokens(10) ===
// total_tokens(49), while 9,924 cached tokens sit outside both.
const ANTHROPIC_TURN_2 = {
  prompt_tokens: 39,
  completion_tokens: 10,
  total_tokens: 49,
  cache_read_input_tokens: 9924,
  cache_creation: { ephemeral_5m_input_tokens: 0 },
  prompt_cache: {
    enabled: true,
    status: "read",
    provider: "anthropic",
    read_tokens: 9924,
    write_tokens: 0,
  },
} as const;

// Anthropic-native turn 1: the cache WRITE that pays for every later read.
const ANTHROPIC_TURN_1 = {
  prompt_tokens: 15,
  completion_tokens: 14,
  total_tokens: 29,
  cache_creation_input_tokens: 9924,
  prompt_cache: {
    enabled: true,
    status: "write",
    provider: "anthropic",
    read_tokens: 0,
    write_tokens: 9924,
  },
} as const;

describe("prompt-cache aware token usage", () => {
  it("keeps the cached share of an INCLUSIVE payload out of the billed tail", () => {
    // The whole point: 8,656 reported prompt tokens are NOT 8,656 tokens billed
    // at the input rate. Only 80 are; the other 8,576 are cache reads.
    expect(readTokenUsage({ usage: ZAI_TURN_2 })).toEqual({
      inputTokens: 80,
      outputTokens: 42,
      cacheReadTokens: 8576,
      cacheWriteTokens: 0,
    });
  });

  it("leaves an EXCLUSIVE payload's tail alone and adds the cache beside it", () => {
    // Subtracting here would be the mirror-image bug: `prompt_tokens` already
    // excludes the 9,924, so the billed tail stays 39.
    expect(readTokenUsage({ usage: ANTHROPIC_TURN_2 })).toEqual({
      inputTokens: 39,
      outputTokens: 10,
      cacheReadTokens: 9924,
      cacheWriteTokens: 0,
    });
  });

  it("captures a cache write", () => {
    expect(readTokenUsage({ usage: ANTHROPIC_TURN_1 })).toEqual({
      inputTokens: 15,
      outputTokens: 14,
      cacheReadTokens: 0,
      cacheWriteTokens: 9924,
    });
  });

  it("reconstructs the real prompt size, which `inputTokens` never was", () => {
    const zai = readTokenUsage({ usage: ZAI_TURN_2 })!;
    const anthropic = readTokenUsage({ usage: ANTHROPIC_TURN_2 })!;
    // Both turns carried a ~8.6k / ~10k prompt. Reading `inputTokens` as
    // context size would report 80 and 39.
    expect(promptTokens(zai)).toBe(8656);
    expect(promptTokens(anthropic)).toBe(9963);
    expect(zai.inputTokens).toBe(80);
    expect(anthropic.inputTokens).toBe(39);
  });

  it("does not double-count the router's normalized echo of the same tokens", () => {
    // `prompt_cache.read_tokens` repeats `cached_tokens` / `cache_read_input_tokens`.
    // Summing both would report ~2x the prompt.
    expect(readTokenUsage({ usage: ZAI_TURN_2 })!.cacheReadTokens).toBe(8576);
    expect(readTokenUsage({ usage: ANTHROPIC_TURN_2 })!.cacheReadTokens).toBe(
      9924,
    );
  });

  it("falls back to a bare cache bag only when no provider-native key is present", () => {
    // opencode's shape: `input` is already the uncached tail, so the bag's
    // counters sit BESIDE it and 100 stays 100.
    expect(
      readTokenUsage({
        usage: {
          input: 100,
          output: 5,
          cache: { read: 60, write: 0 },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 60,
      cacheWriteTokens: 0,
    });
  });

  it("lets a provider-native inclusive key outrank the router's echo of it", () => {
    // Both spellings name the SAME 8,576 tokens. Adding them would double the
    // prompt; letting the echo win would leave 8,576 billed at the full rate.
    const usage = readTokenUsage({ usage: ZAI_TURN_2 })!;
    expect(usage.cacheReadTokens).toBe(8576);
    expect(usage.inputTokens).toBe(80);
    expect(promptTokens(usage)).toBe(8656);
  });

  it("reports a hit rate over the whole prompt, not the tail", () => {
    expect(cacheHitRate(readTokenUsage({ usage: ZAI_TURN_2 })!)).toBeCloseTo(
      8576 / 8656,
      6,
    );
    // A producer that said nothing about caching is UNKNOWN, never 0%.
    expect(
      cacheHitRate({ inputTokens: 500, outputTokens: 10 }),
    ).toBeUndefined();
  });

  it("never emits a negative billed tail", () => {
    expect(
      readTokenUsage({
        usage: { prompt_tokens: 10, cached_tokens: 999, completion_tokens: 1 },
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 1,
      cacheReadTokens: 999,
      cacheWriteTokens: undefined,
    });
  });

  it("returns usage for a cache-only payload", () => {
    expect(readTokenUsage({ usage: { cache_read_input_tokens: 1234 } })).toEqual(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1234 },
    );
  });

  it("stays undefined when nothing at all was reported", () => {
    expect(readTokenUsage({ usage: { model: "glm-5.2" } })).toBeUndefined();
  });

  it("sums the cache counters across turns", () => {
    const t1 = readTokenUsage({ usage: ANTHROPIC_TURN_1 })!;
    const t2 = readTokenUsage({ usage: ANTHROPIC_TURN_2 })!;
    expect(addTokenUsage(t1, t2)).toEqual({
      inputTokens: 54,
      outputTokens: 24,
      cacheReadTokens: 9924,
      cacheWriteTokens: 9924,
    });
  });

  it("keeps an unmetered producer's cache counters absent, not zero", () => {
    const plain = readTokenUsage({ usage: { input: 10, output: 2 } })!;
    expect(plain).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(addTokenUsage(plain, plain).cacheReadTokens).toBeUndefined();
  });

  it("preserves the pre-cache behaviour for payloads with no cache fields", () => {
    expect(
      readTokenUsage({ tokenUsage: { prompt_tokens: "12", completion_tokens: 3.8 } }),
    ).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it("freezes the cache key vocabularies", () => {
    for (const keys of [
      TOKEN_USAGE_CACHE_READ_INCLUSIVE_KEYS,
      TOKEN_USAGE_CACHE_READ_EXCLUSIVE_KEYS,
      TOKEN_USAGE_CACHE_WRITE_INCLUSIVE_KEYS,
      TOKEN_USAGE_CACHE_WRITE_EXCLUSIVE_KEYS,
      TOKEN_USAGE_DETAIL_KEYS,
    ]) {
      expect(Object.isFrozen(keys)).toBe(true);
    }
  });
});
