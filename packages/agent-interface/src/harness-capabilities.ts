import type { ReasoningEffort } from "./agent-profile.js";
import { canonicalizeHarness, type HarnessType } from "./harness.js";

/**
 * The unified harness capability layer — the single source of truth for:
 *   1. harness ↔ model compatibility (which models a harness can run), and
 *   2. reasoning-effort support (which thinking levels a harness/model expresses).
 *
 * Both are facets of the same question — "what can this (harness, model) pair actually do" — and
 * apply to BOTH harness-backed systems (vendor-locked CLIs like claude-code/codex/kimi) AND
 * router-backed systems (opencode, cli-base: any model the router serves). Lifted here so the
 * cli-bridge backends, the sandbox UI pickers, and the router all read one truth instead of each
 * hand-rolling a divergent copy.
 *
 * Grounded in cli-bridge's real backend clamps (codex caps at `high`, kimi is binary on/off, claude
 * carries the full range, cli-base has no agent) — NOT a guessed matrix. The per-MODEL reasoning
 * capability (does this specific model reason at all) is dynamic catalog data the caller supplies.
 */

/** low → high. `none` = thinking off; `ultracode` = max (claude-code mode). */
export const reasoningLadder: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
];

// ── Harness ↔ model compatibility ────────────────────────────────────────────

/**
 * Provider prefixes a harness is vendor-locked to (canonical-id prefix, e.g. `anthropic`, `openai`).
 * A harness with no entry is router-backed: it runs any model. Keyed by the BASE runner — aliases
 * (`claude`/`claudish`/`kimi`) resolve through `canonicalizeHarness` first.
 */
const harnessProviderLock: Partial<Record<HarnessType, readonly string[]>> = {
  "claude-code": ["anthropic"],
  nanoclaw: ["anthropic"],
  codex: ["openai"],
  "kimi-code": ["moonshot"],
};

/** Provider prefix of a canonical model id (`anthropic/claude-…` → `anthropic`), or null. */
export function modelProvider(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : null;
}

/** The providers a harness is locked to, or `null` when it is router-backed (any model). */
export function harnessProviders(
  harness: HarnessType,
): readonly string[] | null {
  return harnessProviderLock[canonicalizeHarness(harness)] ?? null;
}

/**
 * Whether a harness can run a model. Router-backed harnesses (no provider lock) accept anything;
 * a model id with no provider prefix (a sentinel like `default`) is treated as compatible too.
 */
export function harnessSupportsModel(
  harness: HarnessType,
  modelId: string,
): boolean {
  const providers = harnessProviders(harness);
  if (!providers) return true;
  const provider = modelProvider(modelId);
  return provider === null || providers.includes(provider);
}

/** The harness to adopt for a model whose provider is vendor-locked (`anthropic` → `claude-code`,
 *  `openai` → `codex`, `moonshot` → `kimi-code`); `null` when any router-backed harness will do. */
export function preferredHarnessForModel(modelId: string): HarnessType | null {
  const provider = modelProvider(modelId);
  if (!provider) return null;
  for (const [harness, providers] of Object.entries(harnessProviderLock)) {
    if (providers?.includes(provider)) return harness as HarnessType;
  }
  return null;
}

// ── Reasoning-effort support ──────────────────────────────────────────────────

/**
 * The highest reasoning effort a harness's runtime can express (its native clamp ceiling). Grounded
 * in cli-bridge: codex's `model_reasoning_effort` caps at `high` (xhigh/ultracode clamp down); kimi's
 * `--thinking` is binary, so `high` is its "on"; claude-code carries the full range; `cli-base` has
 * no agent and thus no thinking. Router/model-driven harnesses default to the full range.
 */
const harnessReasoningCeiling: Partial<Record<HarnessType, ReasoningEffort>> = {
  "cli-base": "none",
  codex: "high",
  "kimi-code": "high",
  "claude-code": "ultracode",
  nanoclaw: "ultracode",
};

/** The reasoning efforts a harness can express, independent of model — `none` up to its ceiling. */
export function harnessReasoningEfforts(
  harness: HarnessType,
): readonly ReasoningEffort[] {
  const ceiling =
    harnessReasoningCeiling[canonicalizeHarness(harness)] ?? "ultracode";
  return reasoningLadder.slice(0, reasoningLadder.indexOf(ceiling) + 1);
}

/** What the caller knows about a model's own reasoning capability (from a model catalog). */
export interface ModelReasoningCapability {
  /** Does the model reason at all? `false` → only `none` is offered, on any harness. */
  supportsReasoning?: boolean;
  /** The model's own ceiling, if narrower than the harness's. */
  maxEffort?: ReasoningEffort;
}

/**
 * The effective reasoning efforts for a (harness, model) pair: the harness clamp, further narrowed by
 * the model's own capability. A model that doesn't reason collapses to `['none']`; a model with a
 * lower ceiling caps the list there. Pass `model` from your catalog; omit it for the harness-only set.
 */
export function reasoningEffortsFor(
  harness: HarnessType,
  model?: ModelReasoningCapability | null,
): readonly ReasoningEffort[] {
  if (model?.supportsReasoning === false) return ["none"];
  let efforts = harnessReasoningEfforts(harness);
  if (model?.maxEffort) {
    const cap = reasoningLadder.indexOf(model.maxEffort);
    if (cap >= 0)
      efforts = efforts.filter((e) => reasoningLadder.indexOf(e) <= cap);
  }
  return efforts;
}
