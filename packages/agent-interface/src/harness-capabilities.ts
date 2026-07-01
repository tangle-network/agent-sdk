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
 * Grounded in cli-bridge's real backend clamps (codex is `low..xhigh` for current models, kimi is
 * binary on/off, claude carries the full range, cli-base has no agent) — NOT a guessed matrix. The
 * per-MODEL reasoning capability (does this specific model reason at all) is dynamic catalog data the
 * caller supplies.
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
 *
 * `nanoclaw` is deliberately absent despite the "claw" name: its runner routes every provider through
 * the Tangle router (canonical model id straight to the gateway), so it is router-backed like
 * `opencode` — not Anthropic-locked.
 */
const harnessProviderLock: Partial<Record<HarnessType, readonly string[]>> = {
  "claude-code": ["anthropic"],
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

// ── Harness ↔ model snapping (catalog-aware) ─────────────────────────────────

/**
 * Per-harness ranking patterns for {@link snapModelToHarness}, best first; within one pattern the
 * highest version wins (numeric-aware). Only vendor-locked harnesses need an entry — a router-backed
 * harness never snaps (it runs the model as-is). Keyed by the BASE runner (aliases canonicalized).
 */
const harnessPreferredModelPatterns: Partial<
  Record<HarnessType, readonly RegExp[]>
> = {
  "claude-code": [
    /^anthropic\/claude-opus-[\d.-]+$/,
    /^anthropic\/claude-sonnet-[\d.-]+$/,
    /^anthropic\//,
  ],
  codex: [/^openai\/gpt-\d+(\.\d+)?$/, /^openai\/gpt/, /^openai\//],
  "kimi-code": [/^moonshot\//],
};

const numericDesc = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * Keep `modelId` when the harness can run it; otherwise return the harness's best compatible id from
 * `candidateIds` (preferred patterns in order, highest version within a pattern). When nothing in the
 * candidate list fits, the original id is returned unchanged so the caller sees the incompatibility
 * instead of a silent wrong substitution. `candidateIds` are canonical ("provider/model") ids — the
 * caller maps its own catalog shape down to ids, keeping this layer catalog-agnostic.
 */
export function snapModelToHarness(
  harness: HarnessType,
  modelId: string,
  candidateIds: readonly string[],
): string {
  if (harnessSupportsModel(harness, modelId)) return modelId;
  const patterns =
    harnessPreferredModelPatterns[canonicalizeHarness(harness)] ?? [];
  for (const pattern of patterns) {
    const matches = candidateIds
      .filter((id) => pattern.test(id))
      .sort((a, b) => numericDesc.compare(b, a));
    if (matches.length > 0) return matches[0]!;
  }
  return candidateIds.find((id) => harnessSupportsModel(harness, id)) ?? modelId;
}

/**
 * Keep the harness when it can run `modelId`; otherwise return the model's native harness
 * (anthropic → claude-code, openai → codex, moonshot → kimi-code), falling back to the router-backed
 * `opencode` for everything else.
 */
export function snapHarnessToModel(
  harness: HarnessType,
  modelId: string,
): HarnessType {
  if (harnessSupportsModel(harness, modelId)) return harness;
  return preferredHarnessForModel(modelId) ?? "opencode";
}

// ── Reasoning-effort support ──────────────────────────────────────────────────

/**
 * The explicit reasoning-effort set a harness's runtime accepts when it ISN'T a plain `none…ceiling`
 * slice — grounded in the cli-bridge adapters (NOT the canonical ladder):
 *   - codex: current models advertise `low|medium|high|xhigh`; `none` is omitted (use `auto`) and
 *     legacy `minimal` requests clamp up to `low`.
 *   - claude-code: `--effort` accepts `low|medium|high|xhigh|max`. `ultracode` is the ladder's stand-in
 *     for claude's `max` (clamped at runtime); `minimal`→`low` and `none`/`auto`→no flag, so both are
 *     dropped as redundant.
 *   - pi / openclaw: `--thinking` accepts `minimal…xhigh` (max/ultracode clamp to `xhigh`; no `none`).
 *   - kimi-code: `--thinking` is BINARY (off/on) — `minimal` is the only value that emits
 *     `--no-thinking`, `high` is "thinking on". So two levels, not five.
 */
const harnessReasoningEffortsOverride: Partial<
  Record<HarnessType, readonly ReasoningEffort[]>
> = {
  codex: ["low", "medium", "high", "xhigh"],
  "claude-code": ["low", "medium", "high", "xhigh", "ultracode"],
  pi: ["minimal", "low", "medium", "high", "xhigh"],
  openclaw: ["minimal", "low", "medium", "high", "xhigh"],
  "kimi-code": ["minimal", "high"],
};

/**
 * The ceiling for harnesses whose set IS a plain `none…ceiling` slice. Only the no-thinking runners
 * need an entry (`cli-base` has no agent; `nanoclaw` sends no thinking flag). Harnesses with a
 * provider-clamped or non-contiguous set live in {@link harnessReasoningEffortsOverride}; router /
 * model-driven harnesses (opencode, gemini, …) have no entry → default to the full ladder, narrowed
 * by the model's own capability.
 */
const harnessReasoningCeiling: Partial<Record<HarnessType, ReasoningEffort>> = {
  "cli-base": "none",
  nanoclaw: "none",
};

/** The reasoning efforts a harness can express, independent of model — its explicit override set, or
 *  `none` up to its ceiling (default `ultracode` for router/model-driven harnesses). */
export function harnessReasoningEfforts(
  harness: HarnessType,
): readonly ReasoningEffort[] {
  const canonical = canonicalizeHarness(harness);
  const override = harnessReasoningEffortsOverride[canonical];
  if (override) return override;
  const ceiling = harnessReasoningCeiling[canonical] ?? "ultracode";
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

// ── Per-turn selector support (does the harness honor the chat pickers?) ──────

/**
 * Harnesses whose runner DROPS a per-turn selector — grounded in the cli-bridge adapter audit, NOT a
 * guess. Most harnesses honor both selectors, so only the exceptions are listed; a harness absent from
 * a set honors that selector. Keyed by the BASE runner (aliases canonicalized).
 *
 *   - model dropped:  `amp` (own agent picks the model), `openclaw` (dispatcher routes by its own
 *     config), `nanoclaw` (socket-bridge runner is config/env-driven).
 *   - effort dropped: `amp`, `factory-droids`, `hermes`, `nanoclaw`, and `acp` (no thinking flag is
 *     plumbed to the underlying CLI — the runner reads no `reasoningEffort`).
 *
 * This is distinct from {@link reasoningEffortsFor} (which levels a harness can EXPRESS): a picker uses
 * these to trim or mark harnesses up front, so a user's model/effort choice is never silently ignored.
 */
const harnessIgnoresModel: ReadonlySet<HarnessType> = new Set([
  "amp",
  "openclaw",
  "nanoclaw",
]);
const harnessIgnoresEffort: ReadonlySet<HarnessType> = new Set([
  "amp",
  "factory-droids",
  "hermes",
  "nanoclaw",
  "acp",
]);

/** Whether the harness's runner honors a per-turn MODEL override (vs. picking the model itself). */
export function harnessHonorsModel(harness: HarnessType): boolean {
  return !harnessIgnoresModel.has(canonicalizeHarness(harness));
}

/** Whether the harness's runner honors a reasoning-EFFORT override (vs. dropping it). */
export function harnessHonorsEffort(harness: HarnessType): boolean {
  return !harnessIgnoresEffort.has(canonicalizeHarness(harness));
}

/** Whether the harness honors BOTH chat selectors — i.e. the model and effort pickers are live. */
export function harnessHonorsSelectors(harness: HarnessType): boolean {
  return harnessHonorsModel(harness) && harnessHonorsEffort(harness);
}
