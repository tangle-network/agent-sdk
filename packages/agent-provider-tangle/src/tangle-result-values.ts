import type { ExecResult as SandboxExecResult } from "@tangle-network/sandbox";
import type { ExecResult } from "@tangle-network/agent-interface/environment-provider";
import type { TokenUsage } from "@tangle-network/agent-interface";
import { assertBoundedJson, boundedString } from "./tangle-contract-safety.js";

export function execResultFromSandboxExecResult(result: SandboxExecResult | undefined): ExecResult {
  if (!result || typeof result !== "object") {
    throw new Error("Tangle Sandbox exec returned no result");
  }
  const record = result as unknown as Record<string, unknown>;
  assertBoundedJson(record);
  if (
    typeof record.exitCode !== "number" ||
    !Number.isSafeInteger(record.exitCode)
  ) {
    throw new Error("Tangle Sandbox exec returned an invalid exit code");
  }
  if (typeof record.stdout !== "string" || typeof record.stderr !== "string") {
    throw new Error("Tangle Sandbox exec returned invalid output streams");
  }
  return {
    exitCode: record.exitCode,
    stdout: boundedString(record.stdout, "Tangle exec stdout"),
    stderr: boundedString(record.stderr, "Tangle exec stderr"),
  };
}
export function tokenUsageFromData(data: Record<string, unknown>): TokenUsage | undefined {
  assertBoundedJson(data);
  if (
    data.usage !== undefined &&
    (!data.usage || typeof data.usage !== "object" || Array.isArray(data.usage))
  ) {
    throw new Error("Tangle usage must be an object");
  }
  if (
    data.tokenUsage !== undefined &&
    (!data.tokenUsage ||
      typeof data.tokenUsage !== "object" ||
      Array.isArray(data.tokenUsage))
  ) {
    throw new Error("Tangle token usage must be an object");
  }
  // Only an explicit usage object counts. Scanning the raw event body turned
  // any field named like a token count into a reported total, including on
  // events that carry no usage at all.
  const usageRecord =
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : data.tokenUsage && typeof data.tokenUsage === "object"
        ? (data.tokenUsage as Record<string, unknown>)
        : undefined;
  if (usageRecord === undefined) return undefined;
  assertBoundedJson(usageRecord);
  const inputTokens = firstValidatedNumber(
    usageRecord,
    ["inputTokens", "tokensIn", "prompt_tokens"],
    "input token count",
    true,
  );
  const outputTokens = firstValidatedNumber(
    usageRecord,
    ["outputTokens", "tokensOut", "completion_tokens"],
    "output token count",
    true,
  );
  const totalTokens = firstValidatedNumber(
    usageRecord,
    ["totalTokens", "tokensTotal", "total_tokens"],
    "total token count",
    true,
  );
  const cacheReadInputTokens = firstValidatedNumber(
    usageRecord,
    ["cacheReadInputTokens", "cacheReadTokens", "cache_read_input_tokens"],
    "cache-read token count",
    true,
  );
  const cacheCreationInputTokens = firstValidatedNumber(
    usageRecord,
    [
      "cacheCreationInputTokens",
      "cacheWriteInputTokens",
      "cacheCreationTokens",
      "cache_creation_input_tokens",
    ],
    "cache-creation token count",
    true,
  );
  const reasoningTokens = firstValidatedNumber(
    usageRecord,
    ["reasoningTokens", "reasoning_tokens"],
    "reasoning token count",
    true,
  );
  const nestedCost = firstValidatedNumber(
    usageRecord,
    ["cost", "costUsd", "totalCostUsd"],
    "usage cost",
    false,
  );
  const topLevelCost = firstValidatedNumber(
    data,
    ["costUsd", "totalCostUsd"],
    "result cost",
    false,
  );
  const cost = nestedCost ?? topLevelCost;
  // `TokenUsage` cannot express "not reported", so a usage record is only
  // emitted when both counts were actually measured. Emitting a cost beside
  // two zeroes published an unmeasured total as a measured one.
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens }
      : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens }
      : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

function firstValidatedNumber(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
  integer: boolean,
): number | undefined {
  let selected: number | undefined;
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isSafeInteger(value))
    ) {
      throw new Error(`Tangle ${label} is invalid`);
    }
    selected ??= value;
  }
  return selected;
}
