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

export interface TokenUsageCounts {
  inputTokens: number;
  outputTokens: number;
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

export function readTokenUsage(
  data: Record<string, unknown>,
): TokenUsageCounts | undefined {
  const source = tokenUsageSource(data);
  const inputTokens = firstTokenCount(source, TOKEN_USAGE_INPUT_KEYS);
  const outputTokens = firstTokenCount(source, TOKEN_USAGE_OUTPUT_KEYS);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  };
}

export function readTokenCostUsd(
  data: Record<string, unknown>,
): number | undefined {
  const direct = firstUsageCostUsd(data);
  if (direct !== undefined) return direct;
  return firstUsageCostUsd(tokenUsageSource(data));
}

export function addTokenUsage(
  current: TokenUsageCounts | undefined,
  next: TokenUsageCounts,
): TokenUsageCounts {
  return current
    ? {
        inputTokens: current.inputTokens + next.inputTokens,
        outputTokens: current.outputTokens + next.outputTokens,
      }
    : next;
}
