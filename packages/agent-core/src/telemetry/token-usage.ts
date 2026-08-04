/**
 * Candidate field names for a producer-supplied `tokenUsage` bag on a
 * `message.updated` trace event. Agents and SDK layers disagree on the
 * spelling: `StreamTokenUsage` emits `inputTokens`/`outputTokens`, the eval and
 * workflow agent.run paths emit `input`/`output`, and persisted / foreign
 * shapes use snake_case or prompt/completion naming. A reader that wants the
 * token counts must try all of them, highest-priority first, or it silently
 * drops usage for the producers it does not name.
 *
 * Shared so every `tokenUsage` reader (the trace sink's root-span aggregation,
 * the signal extractor) keys off the identical set and cannot drift.
 *
 * Distinct layer from `genai-attributes.ts`: those keys (`GEN_AI_*_TOKEN_KEYS`)
 * name OTel SPAN ATTRIBUTES on an already-lowered span; these name the fields of
 * the raw producer `tokenUsage` OBJECT before lowering. A new producer that
 * spells token usage differently may need an entry in BOTH places.
 */
export const TOKEN_USAGE_INPUT_KEYS: readonly string[] = Object.freeze([
  "inputTokens",
  "input",
  "input_tokens",
  "promptTokens",
  "prompt_tokens",
]);

export const TOKEN_USAGE_OUTPUT_KEYS: readonly string[] = Object.freeze([
  "outputTokens",
  "output",
  "output_tokens",
  "completionTokens",
  "completion_tokens",
]);

export const TOKEN_USAGE_COST_KEYS: readonly string[] = Object.freeze([
  "totalCostUsd",
  "costUsd",
  "total_cost_usd",
  "cost_usd",
  "cost",
]);

/**
 * Prompt-cache counters, split by whether the provider ALREADY counted them
 * inside its input/prompt token field. The split is not cosmetic: the two
 * families disagree, and a reader that ignores the disagreement reports a
 * number that is wrong in one direction or the other on every call.
 *
 * INCLUSIVE (OpenAI-compatible): `prompt_tokens` is the WHOLE prompt and
 * `prompt_tokens_details.cached_tokens` names the cached share of it. Measured
 * on router.tangle.tools against `glm-5.2` (provider `zai`):
 * `prompt_tokens=8656, cached_tokens=8576, completion=42, total=8698` —
 * `8656 + 42 === 8698`, so the cached tokens are inside `prompt_tokens`.
 *
 * EXCLUSIVE (Anthropic-native): `input_tokens` is only the UNCACHED tail and
 * `cache_read_input_tokens` sits beside it. Measured on the same router,
 * same request shape: `prompt_tokens=39, cache_read_input_tokens=9924,
 * completion=10, total=49` — `39 + 10 === 49`, so the 9,924 cached tokens are
 * NOT in `prompt_tokens`.
 *
 * Both shapes reach a caller through the same OpenAI-compatible endpoint, so
 * the convention cannot be inferred from the transport — only from which key
 * carried the count. That is why these are two lists and not one.
 */
export const TOKEN_USAGE_CACHE_READ_INCLUSIVE_KEYS: readonly string[] =
  Object.freeze([
    "cached_tokens",
    "cachedTokens",
    "cached_input_tokens",
    "cachedInputTokens",
  ]);

export const TOKEN_USAGE_CACHE_READ_EXCLUSIVE_KEYS: readonly string[] =
  Object.freeze([
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
    "cacheReadTokens",
    "cache_read",
  ]);

export const TOKEN_USAGE_CACHE_WRITE_INCLUSIVE_KEYS: readonly string[] =
  Object.freeze(["cache_write_tokens", "cacheWriteTokens"]);

export const TOKEN_USAGE_CACHE_WRITE_EXCLUSIVE_KEYS: readonly string[] =
  Object.freeze([
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_tokens",
    "cacheCreationTokens",
    "cache_write",
  ]);

/** Nested bags that spell cache counters with the SAME vocabulary as the flat
 *  usage object — the OpenAI-compatible `*_details` shape, whose
 *  `cached_tokens` is inclusive. Searched after the flat keys, in this order. */
export const TOKEN_USAGE_DETAIL_KEYS: readonly string[] = Object.freeze([
  "prompt_tokens_details",
  "input_tokens_details",
  "promptTokensDetails",
  "inputTokensDetails",
]);

/**
 * Dedicated prompt-cache bags, which spell their counters with BARE names
 * (`read` / `write`) that only mean "cache" because of the bag they sit in.
 * `cache` is opencode's `step_finish.tokens.cache`; `prompt_cache` is the
 * Tangle router's provider-normalized bag.
 *
 * Counters found here are treated as EXCLUSIVE of the reported input total.
 * Measured for opencode on 2026-08-03, `glm-5.2` via the router:
 * `{total: 17007, input: 16940, output: 3, reasoning: 0, cache: {read: 64, write: 0}}`
 * — `16940 + 64 + 0 + 3 === 17007`, so `input` is the uncached tail. The
 * router's `prompt_cache` only ever reaches a caller ALONGSIDE the
 * provider-native key, which wins over this fallback, so this rule decides
 * only the opencode-shaped case it was measured on.
 */
export const TOKEN_USAGE_CACHE_BAG_KEYS: readonly string[] = Object.freeze([
  "cache",
  "prompt_cache",
  "promptCache",
]);

export const TOKEN_USAGE_CACHE_BAG_READ_KEYS: readonly string[] = Object.freeze(
  ["read", "read_tokens", "readTokens"],
);

export const TOKEN_USAGE_CACHE_BAG_WRITE_KEYS: readonly string[] =
  Object.freeze(["write", "write_tokens", "writeTokens"]);

/**
 * Normalized token counts for one call.
 *
 * The three prompt-side fields are DISJOINT and additive by construction:
 * `inputTokens + cacheReadTokens + cacheWriteTokens` is the size of the whole
 * prompt the model saw, and each term is billed at its own rate. `inputTokens`
 * is the freshly-billed tail ONLY — it is not the context size, and reading it
 * as one understates a warm agent loop's context by the cached share, which on
 * a stable-prefix loop is the overwhelming majority of it.
 */
export interface TokenUsageCounts {
  /** Prompt tokens billed at the full input rate: the uncached tail. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache, billed at the
   *  (much cheaper) cache-read rate. Absent when the producer reported no
   *  cache information at all — which is not the same as a measured zero. */
  cacheReadTokens?: number;
  /** Prompt tokens written INTO the provider's cache on this call. */
  cacheWriteTokens?: number;
}

export function tokenCount(value: unknown): number | undefined {
  if (typeof value === "boolean") return undefined;
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    n = trimmed === "" ? Number.NaN : Number(trimmed);
  } else {
    n = Number.NaN;
  }
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}

export function firstTokenCount(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const count = tokenCount(source[key]);
    if (count !== undefined) return count;
  }
  return undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "boolean") return undefined;
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    n = trimmed === "" ? Number.NaN : Number(trimmed);
  } else {
    n = Number.NaN;
  }
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function firstUsageCostUsd(
  source: Record<string, unknown> | undefined,
  keys: readonly string[] = TOKEN_USAGE_COST_KEYS,
): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const cost = finiteNonNegativeNumber(source[key]);
    if (cost !== undefined) return cost;
  }
  return undefined;
}

export function tokenUsageSource(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (data.tokenUsage && typeof data.tokenUsage === "object") {
    return data.tokenUsage as Record<string, unknown>;
  }
  if (data.usage && typeof data.usage === "object") {
    return data.usage as Record<string, unknown>;
  }
  return data;
}

/** Every place a cache counter can hide for one call: the usage bag itself,
 *  then each nested detail bag, in `TOKEN_USAGE_DETAIL_KEYS` order. */
function usageBags(
  source: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const bags: Record<string, unknown>[] = [source];
  for (const key of TOKEN_USAGE_DETAIL_KEYS) {
    const nested = source[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      bags.push(nested as Record<string, unknown>);
    }
  }
  return bags;
}

/** First match for `keys` across the usage bag and its nested detail bags. */
function cacheCount(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const bag of usageBags(source)) {
    const count = firstTokenCount(bag, keys);
    if (count !== undefined) return count;
  }
  return undefined;
}

/** First match for a bare-named counter inside a dedicated cache bag. */
function cacheBagCount(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of TOKEN_USAGE_CACHE_BAG_KEYS) {
    const bag = source[key];
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
    const count = firstTokenCount(bag as Record<string, unknown>, keys);
    if (count !== undefined) return count;
  }
  return undefined;
}

/**
 * One provider's cache counters, normalized so the caller never has to know
 * which convention produced them. `inclusive` is the amount already counted
 * inside the reported input/prompt total and therefore must be SUBTRACTED from
 * it; `exclusive` sits beside that total and must not be.
 */
function readCacheSplit(source: Record<string, unknown>): {
  read?: number;
  write?: number;
  inclusive: number;
} {
  // Precedence, and the reason for it. A provider reports ONE convention per
  // counter, but a router response can carry TWO spellings of the same tokens:
  // the upstream provider's native key, plus the router's own normalized
  // `prompt_cache` echo of it. Summing both would double the prompt, and
  // letting the echo decide the convention would mis-classify the OpenAI shape
  // (measured: `cached_tokens=8576` inclusive, echoed as
  // `prompt_cache.read_tokens=8576`). So a provider-native key ALWAYS outranks
  // the bag, and the bag is consulted only when no native key was reported.
  const resolve = (
    inclusiveKeys: readonly string[],
    exclusiveKeys: readonly string[],
    bagKeys: readonly string[],
  ): { count?: number; inclusive: number } => {
    const nativeExclusive = cacheCount(source, exclusiveKeys);
    if (nativeExclusive !== undefined) {
      return { count: nativeExclusive, inclusive: 0 };
    }
    const nativeInclusive = cacheCount(source, inclusiveKeys);
    if (nativeInclusive !== undefined) {
      return { count: nativeInclusive, inclusive: nativeInclusive };
    }
    const fromBag = cacheBagCount(source, bagKeys);
    return fromBag !== undefined
      ? { count: fromBag, inclusive: 0 }
      : { inclusive: 0 };
  };

  const read = resolve(
    TOKEN_USAGE_CACHE_READ_INCLUSIVE_KEYS,
    TOKEN_USAGE_CACHE_READ_EXCLUSIVE_KEYS,
    TOKEN_USAGE_CACHE_BAG_READ_KEYS,
  );
  const write = resolve(
    TOKEN_USAGE_CACHE_WRITE_INCLUSIVE_KEYS,
    TOKEN_USAGE_CACHE_WRITE_EXCLUSIVE_KEYS,
    TOKEN_USAGE_CACHE_BAG_WRITE_KEYS,
  );

  return {
    ...(read.count !== undefined ? { read: read.count } : {}),
    ...(write.count !== undefined ? { write: write.count } : {}),
    inclusive: read.inclusive + write.inclusive,
  };
}

export function readTokenUsage(
  data: Record<string, unknown>,
): TokenUsageCounts | undefined {
  const source = tokenUsageSource(data);
  const reportedInput = firstTokenCount(source, TOKEN_USAGE_INPUT_KEYS);
  const outputTokens = firstTokenCount(source, TOKEN_USAGE_OUTPUT_KEYS);
  const cache = readCacheSplit(source);
  if (
    reportedInput === undefined &&
    outputTokens === undefined &&
    cache.read === undefined &&
    cache.write === undefined
  ) {
    return undefined;
  }

  // Clamped, because a provider whose cached count exceeds its own reported
  // prompt total is reporting something we cannot reconcile — a negative
  // billed-tail is never the right answer, and silently emitting one would
  // corrupt every cost sum downstream.
  const inputTokens = Math.max(0, (reportedInput ?? 0) - cache.inclusive);

  return {
    inputTokens,
    outputTokens: outputTokens ?? 0,
    ...(cache.read !== undefined ? { cacheReadTokens: cache.read } : {}),
    ...(cache.write !== undefined ? { cacheWriteTokens: cache.write } : {}),
  };
}

export function readTokenCostUsd(
  data: Record<string, unknown>,
): number | undefined {
  const direct = firstUsageCostUsd(data);
  if (direct !== undefined) return direct;
  return firstUsageCostUsd(tokenUsageSource(data));
}

/** Sum an optional counter across two calls, staying `undefined` only when
 *  NEITHER side reported it — so "no producer ever mentioned the cache" stays
 *  distinguishable from "the cache was measured and it was zero". */
function addOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

export function addTokenUsage(
  current: TokenUsageCounts | undefined,
  next: TokenUsageCounts,
): TokenUsageCounts {
  if (!current) return next;
  const cacheReadTokens = addOptional(
    current.cacheReadTokens,
    next.cacheReadTokens,
  );
  const cacheWriteTokens = addOptional(
    current.cacheWriteTokens,
    next.cacheWriteTokens,
  );
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

/** The size of the prompt the model actually saw: billed tail + cache read +
 *  cache write. This — never `inputTokens` — is the number to read as "context
 *  size", and the gap between them is the whole point of the cache. */
export function promptTokens(usage: TokenUsageCounts): number {
  return (
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/** Share of the prompt served from cache, in `[0, 1]`. `undefined` when the
 *  producer reported no cache information, so an unmetered path cannot be read
 *  as a 0% hit rate. */
export function cacheHitRate(usage: TokenUsageCounts): number | undefined {
  if (usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined) {
    return undefined;
  }
  const total = promptTokens(usage);
  return total === 0 ? 0 : (usage.cacheReadTokens ?? 0) / total;
}
