import {
  type AgentProfileSystemPromptCapability,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "./agent-profile.js";
import type { HarnessType } from "./harness.js";

/**
 * The unified harness capability layer — the single source of truth for:
 *   1. harness ↔ model compatibility (which models a harness can run),
 *   2. reasoning-effort support (which thinking levels a harness/model expresses), and
 *   3. system-prompt intents (whether a harness can replace its own prompt, add to it, or neither).
 *
 * All are facets of the same question — "what can this (harness, model) pair actually do" — and
 * apply to BOTH harness-backed systems (vendor-locked CLIs like claude-code/codex/kimi) AND
 * router-backed systems (opencode, cli-base: any model the router serves). Lifted here so the
 * cli-bridge backends, the sandbox UI pickers, and the router all read one truth instead of each
 * hand-rolling a divergent copy.
 *
 * Grounded in the native CLI controls (Codex is `minimal..ultra`, Kimi is binary on/off, Claude is
 * `low..max`, cli-base has no agent) — NOT a guessed matrix. The
 * per-MODEL reasoning capability (does this specific model reason at all) is dynamic catalog data the
 * caller supplies.
 */

/** low → high. `none` = thinking off; `ultracode` = max (claude-code mode). */
export const reasoningLadder: readonly ReasoningEffort[] = REASONING_EFFORTS;

// ── Harness ↔ model compatibility ────────────────────────────────────────────

/**
 * Provider prefixes a harness is vendor-locked to (canonical-id prefix, e.g. `anthropic`, `openai`).
 * A harness with no entry is router-backed: it runs any model, except the measured exclusions in
 * {@link harnessModelExclusions}.
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

/**
 * Model families whose bare ids belong to one provider. The Router catalog serves most ids without a
 * prefix (`claude-sonnet-5-5`, `gpt-5.5`, `glm-5.3`) and names the provider beside them, so a check
 * that read every bare id as "any provider" offered `claude-code` with `glm-5.3`.
 */
const bareModelFamilyProviders: readonly (readonly [RegExp, string])[] = [
  [/^claude-/, "anthropic"],
  [/^(gpt-|chatgpt-|codex-|o\d+(-|$))/, "openai"],
  [/^(kimi-|moonshot-)/, "moonshot"],
  [/^gemini-/, "google"],
  [/^glm-/, "zai"],
  [/^deepseek-/, "deepseek"],
  [/^grok-/, "xai"],
];

/**
 * The provider a model id belongs to: its explicit prefix, else the provider of its bare-id family
 * (`claude-sonnet-5-5` → `anthropic`). `null` for an id outside every family, such as the `default`
 * sentinel, whose provider only the serving harness knows.
 */
export function resolveModelProvider(modelId: string): string | null {
  const explicit = modelProvider(modelId);
  if (explicit) return explicit;
  const id = modelId.trim().toLowerCase();
  for (const [family, provider] of bareModelFamilyProviders) {
    if (family.test(id)) return provider;
  }
  return null;
}

/** The providers a harness is locked to, or `null` when it is router-backed (any model). */
export function harnessProviders(
  harness: HarnessType,
): readonly string[] | null {
  return harnessProviderLock[harness] ?? null;
}

/** A harness × model pair that a production run measured to fail at its first model call. */
export interface HarnessModelExclusion {
  readonly harness: HarnessType;
  /** Canonical `provider/model` ids the measurement covers. */
  readonly models: RegExp;
  /**
   * The failure needs a reasoning effort above `none`: the harness sends the rejected control only
   * then, so the same pair without a reasoning effort is not excluded.
   */
  readonly onlyWithReasoningEffort: boolean;
  /** What the provider rejected, and why the harness triggers it. */
  readonly reason: string;
  /** ISO date of the production measurement. */
  readonly measuredOn: string;
  /** Where the measurement is recorded. */
  readonly evidence: string;
}

const SANDBOX_HARNESS_MATRIX_EVIDENCE =
  "https://github.com/tangle-network/agent-dev-container/issues/9382";

/**
 * Pairs a router-backed harness cannot run, measured on production with the Router credential: one
 * prompt per pair, profile reasoning effort `medium` (2026-10-05). The same run passed pi with
 * `openai/gpt-5.5` and `zai/glm-5.3`, and opencode with every model listed here. Pairs not listed
 * were not measured to fail. An entry is removed when its harness adapter or the Router is fixed and
 * the pair passes a new production measurement.
 *
 * pi's chat-completions client (pi-ai 0.85.1) marks a model as reasoning only when the profile asks
 * for a reasoning effort, and only a reasoning model is sent the `developer` role and
 * `reasoning_effort`; that is why the first two entries need a reasoning effort.
 */
export const harnessModelExclusions: readonly HarnessModelExclusion[] = [
  {
    harness: "pi",
    models: /^anthropic\//,
    onlyWithReasoningEffort: true,
    reason:
      'the Router\'s chat-completions route for Anthropic models rejects the "developer" role pi sends ' +
      'to a reasoning model (400 Unexpected role "developer")',
    measuredOn: "2026-10-05",
    evidence: SANDBOX_HARNESS_MATRIX_EVIDENCE,
  },
  {
    harness: "pi",
    models: /^openai\/gpt-5\.6-luna$/,
    onlyWithReasoningEffort: true,
    reason:
      "OpenAI does not accept function tools together with reasoning_effort for this model on " +
      "/v1/chat/completions, the only route pi speaks",
    measuredOn: "2026-10-05",
    evidence: SANDBOX_HARNESS_MATRIX_EVIDENCE,
  },
  {
    harness: "pi",
    models: /^google\/gemini-3\.8-flash$/,
    onlyWithReasoningEffort: false,
    reason:
      "the model requires each function call to return its thought_signature, which pi's " +
      "chat-completions client does not send back (400 Function call is missing a thought_signature)",
    measuredOn: "2026-10-05",
    evidence: SANDBOX_HARNESS_MATRIX_EVIDENCE,
  },
];

/** The answer to "can this harness run this model", with the refusal a caller can show as-is. */
export type HarnessModelSupport =
  | {
      readonly supported: true;
      /** Canonical `provider/model` id when the provider resolved, else the id as given. */
      readonly model: string;
      readonly provider: string | null;
    }
  | {
      readonly supported: false;
      readonly model: string;
      readonly provider: string | null;
      /** The providers a vendor-locked harness accepts; absent for a measured exclusion. */
      readonly allowedProviders?: readonly string[];
      /** The measurement behind a refusal of a router-backed pair. */
      readonly exclusion?: HarnessModelExclusion;
      /** One sentence naming the harness, the model and the reason. */
      readonly message: string;
    };

export interface HarnessModelSupportOptions {
  /** The run's reasoning effort; `null`, `undefined` and `none` all mean no reasoning effort. */
  readonly reasoningEffort?: ReasoningEffort | null;
}

/**
 * Whether a harness can run a model, and why not. A bare id resolves its provider through
 * {@link resolveModelProvider}; an id whose provider cannot be resolved (a sentinel like `default`)
 * is left to the harness, because its provider only the serving harness knows. A vendor-locked
 * harness refuses every other provider; a router-backed harness refuses only the measured
 * {@link harnessModelExclusions}.
 */
export function harnessModelSupport(
  harness: HarnessType,
  modelId: string,
  options: HarnessModelSupportOptions = {},
): HarnessModelSupport {
  const trimmed = modelId.trim();
  const provider = resolveModelProvider(trimmed);
  const model =
    provider !== null && modelProvider(trimmed) === null
      ? `${provider}/${trimmed}`
      : trimmed;
  if (provider === null) return { supported: true, model, provider };

  const allowedProviders = harnessProviders(harness);
  if (allowedProviders && !allowedProviders.includes(provider)) {
    return {
      supported: false,
      model,
      provider,
      allowedProviders,
      message:
        `Harness ${harness} runs only ${allowedProviders.join(" or ")} models; ` +
        `${model} is a ${provider} model. Choose a model whose id starts with ` +
        `${allowedProviders.map((p) => `${p}/`).join(" or ")}, or a harness that runs ` +
        `${provider} models, such as opencode.`,
    };
  }

  const reasoning =
    options.reasoningEffort !== undefined &&
    options.reasoningEffort !== null &&
    options.reasoningEffort !== "none";
  const exclusion = harnessModelExclusions.find(
    (entry) =>
      entry.harness === harness &&
      entry.models.test(model) &&
      (!entry.onlyWithReasoningEffort || reasoning),
  );
  if (exclusion) {
    return {
      supported: false,
      model,
      provider,
      exclusion,
      message:
        `Harness ${harness} cannot run ${model}` +
        (exclusion.onlyWithReasoningEffort ? " with a reasoning effort" : "") +
        `: ${exclusion.reason} (measured ${exclusion.measuredOn}, ${exclusion.evidence}). ` +
        (exclusion.onlyWithReasoningEffort
          ? "Remove model.reasoningEffort, or choose another harness or model."
          : "Choose another harness or model."),
    };
  }
  return { supported: true, model, provider };
}

/**
 * Whether a harness can run a model; {@link harnessModelSupport} gives the reason when it cannot.
 */
export function harnessSupportsModel(
  harness: HarnessType,
  modelId: string,
  options?: HarnessModelSupportOptions,
): boolean {
  return harnessModelSupport(harness, modelId, options).supported;
}

/** The harness to adopt for a model whose provider is vendor-locked (`anthropic` → `claude-code`,
 *  `openai` → `codex`, `moonshot` → `kimi-code`); `null` when any router-backed harness will do. */
export function preferredHarnessForModel(modelId: string): HarnessType | null {
  const provider = resolveModelProvider(modelId);
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
 * harness never snaps (it runs the model as-is).
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
  const patterns = harnessPreferredModelPatterns[harness] ?? [];
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
 * slice — measured against the pinned CLI binaries, NOT inferred from the canonical ladder:
 *   - codex: `model_reasoning_effort` accepts `none|minimal|low|medium|high|xhigh|max`, plus `ultra`
 *     which the API's own enumeration omits but accepts end-to-end; canonical `ultracode` maps to
 *     native `ultra`. Per-model catalog data narrows this list.
 *   - claude-code: `--effort` accepts `low|medium|high|xhigh|max`; canonical `ultracode` maps to
 *     native `max`. It cannot express `none` or `minimal`, and an unsupported value is warned about
 *     and silently replaced with the default rather than rejected — so the set must not overstate.
 *   - pi: `--thinking` accepts `off|minimal|low|medium|high|xhigh`; canonical `none` maps to
 *     `off` and `ultracode` clamps to `xhigh`, its top rung.
 *   - prime: the prime fork of the pi line accepts the same `--thinking` set
 *     (`off|minimal|low|medium|high|xhigh|max`); canonical `none` maps to `off` and `ultracode` to
 *     `max`.
 *   - openclaw: `--thinking` accepts `off|minimal|low|medium|high|xhigh|max` (and `adaptive`, which
 *     defers the choice rather than naming a rung); canonical `none` maps to `off` and `ultracode`
 *     to `max`.
 *   - kimi-code: `--thinking` is binary. Canonical `none` emits `--no-thinking`; any non-none level
 *     emits `--thinking`, represented here by `high`.
 */
const harnessReasoningEffortsOverride: Partial<
  Record<HarnessType, readonly ReasoningEffort[]>
> = {
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "ultracode"],
  "claude-code": ["low", "medium", "high", "xhigh", "ultracode"],
  pi: ["none", "minimal", "low", "medium", "high", "xhigh", "ultracode"],
  prime: ["none", "minimal", "low", "medium", "high", "xhigh", "ultracode"],
  openclaw: [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "ultracode",
  ],
  "kimi-code": ["none", "high"],
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
  const override = harnessReasoningEffortsOverride[harness];
  if (override) return override;
  const ceiling = harnessReasoningCeiling[harness] ?? "ultracode";
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

// ── Native reasoning control (the exact token the harness process receives) ───

/**
 * Canonical effort → the harness's OWN control token, or `null` when the harness applies no
 * native reasoning control for that request. This is the value a materialization receipt carries
 * as `reasoningEffort.applied`, so a caller can check that the effort it asked for reached the
 * process instead of trusting an echo of its own request.
 *
 * Read from the argv builders that actually spawn each CLI, not from help text:
 *   - claude-code — `--effort <value>`; it cannot express `none` or `minimal`, so both clamp to
 *     `low`, and `ultracode` becomes its ceiling `max`.
 *   - codex — `-c model_reasoning_effort="<value>"`; it takes the canonical rungs directly and
 *     names its ceiling `ultra`.
 *   - pi — `--thinking <value>`; `none` becomes `off` and `ultracode` clamps to `xhigh`, the
 *     highest rung the pi line accepts.
 *   - prime — `--thinking <value>`; the fork carries `max` above `xhigh`, so `ultracode` reaches
 *     `max`. This is the one rung where prime and pi differ.
 *   - kimi-code — the control is the FLAG itself, `--thinking` or `--no-thinking`, because kimi's
 *     thinking switch is binary. `medium` is its default and passes no flag at all.
 *   - opencode — the router-backed variant name is the canonical rung unchanged.
 *
 * A harness with no entry applies NO native control: either it derives thinking from the model
 * (gemini's `--thinking-budget`) or it plumbs no thinking flag at all (see
 * {@link harnessHonorsEffort}). Both answer `null`, which is what their receipts carry — so an
 * unknown harness is never asserted to have applied a control it cannot apply.
 */
const harnessNativeReasoningControl: Partial<
  Record<HarnessType, (effort: ReasoningEffort) => string | null>
> = {
  "claude-code": (effort) => {
    if (effort === "none" || effort === "minimal") return "low";
    return effort === "ultracode" ? "max" : effort;
  },
  codex: (effort) => (effort === "ultracode" ? "ultra" : effort),
  pi: (effort) => {
    if (effort === "none") return "off";
    return effort === "ultracode" ? "xhigh" : effort;
  },
  prime: (effort) => {
    if (effort === "none") return "off";
    return effort === "ultracode" ? "max" : effort;
  },
  "kimi-code": (effort) => {
    if (effort === "medium") return null;
    return effort === "none" || effort === "minimal" || effort === "low"
      ? "--no-thinking"
      : "--thinking";
  },
  opencode: (effort) => effort,
};

/**
 * The native control token a harness applies for one canonical effort, or `null` when it applies
 * none. `effort: null` (nothing requested) is always `null`.
 *
 * One owner for both sides of the check: the adapter that builds the harness argv and the caller
 * that verifies the receipt read this function, so a CLI that renames a rung moves both at once
 * instead of turning into a refused run.
 */
export function nativeReasoningControl(
  harness: HarnessType,
  effort: ReasoningEffort | null,
): string | null {
  if (effort === null) return null;
  return harnessNativeReasoningControl[harness]?.(effort) ?? null;
}

// ── Per-turn selector support (does the harness honor the chat pickers?) ──────

/**
 * Harnesses whose runner DROPS a per-turn selector — grounded in the cli-bridge adapter audit, NOT a
 * guess. Most harnesses honor both selectors, so only the exceptions are listed; a harness absent from
 * a set honors that selector.
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
  return !harnessIgnoresModel.has(harness);
}

/** Whether the harness's runner honors a reasoning-EFFORT override (vs. dropping it). */
export function harnessHonorsEffort(harness: HarnessType): boolean {
  return !harnessIgnoresEffort.has(harness);
}

/** Whether the harness honors BOTH chat selectors — i.e. the model and effort pickers are live. */
export function harnessHonorsSelectors(harness: HarnessType): boolean {
  return harnessHonorsModel(harness) && harnessHonorsEffort(harness);
}

// ── System-prompt intents (which prompt channel the harness actually owns) ────

/**
 * The system-prompt intents a harness's own controls can execute, measured by reading the request
 * each installed CLI sends — NOT taken from its help text:
 *
 *   - claude-code 2.1.222 and pi 0.83.0 own both. `--system-prompt` drops the built-in prompt from
 *     the request (27,673 B → the caller's bytes on claude-code, 2,582 B → the caller's on pi);
 *     `--append-system-prompt` leaves it in place and adds the caller's text after it.
 *   - codex 0.146.0 owns replacement only: the `model_instructions_file` config key becomes the
 *     request's entire instructions text. It has no additive control — its AGENTS.md lands in a
 *     developer/user message, not the system channel.
 *   - gemini 0.26.0 owns replacement only: `.gemini/system.md` under `GEMINI_SYSTEM_MD=1` replaces
 *     the base prompt. Its one additive path is GEMINI.md memory, which IS the `instructions`
 *     surface, so an addition lowered there would be byte-indistinguishable from `instructions`.
 *   - opencode 1.17.18 owns addition only THROUGH A WORKSPACE: config-declared `instructions[]`
 *     files compose into the same single `role: "system"` message as its built-in prompt, which
 *     stays in place. Its replacement control (`agent.<name>.prompt`) binds to one agent chosen at
 *     launch, which a workspace plan cannot guarantee — but an executor that selects that agent
 *     can, so `replace: false` here is the plan-forwarding answer, not opencode's ceiling.
 *
 * Every other harness owns NEITHER, including the ones whose prompt path is a `role: "system"` chat
 * message: that message is flattened into the user turn before the CLI sees it, so it is not a
 * system-prompt channel at all — honoring an intent through it would put the caller's text in
 * ordinary user content while the harness's own prompt ran unchanged. A harness with no entry
 * refuses both, so one added later cannot inherit a capability by omission.
 */
const harnessSystemPromptControls: Partial<
  Record<HarnessType, AgentProfileSystemPromptCapability>
> = {
  "claude-code": { replace: true, append: true },
  pi: { replace: true, append: true },
  prime: { replace: true, append: true },
  codex: { replace: true, append: false },
  gemini: { replace: true, append: false },
  opencode: { replace: false, append: true },
};

const noSystemPromptControls: AgentProfileSystemPromptCapability = {
  replace: false,
  append: false,
};

/**
 * Which system-prompt intents a harness honors THROUGH A WORKSPACE — the value an adapter that
 * lowers a profile to files, env vars, and CLI flags and then hands the result to a launcher it
 * does not own should declare as {@link AgentProfileCapabilities.systemPrompt}. That is the shape
 * of every caller today (the cli-bridge and tangle providers both forward a plan), which is why
 * this answer depends on the harness alone.
 *
 * It is NOT the whole truth for an adapter that starts the harness itself, because one control in
 * the table above lives outside any workspace: opencode's `agent.<name>.prompt` really does replace
 * its built-in prompt, but it binds to the single agent whoever starts the server selects. A plan
 * cannot name that agent, so `opencode` reads `replace: false` here — while an adapter that writes
 * opencode's server config AND picks the primary agent (`sdk-provider-opencode`) does honor
 * replacement, and declares `replace: true` for itself. The capability is a property of the
 * (harness, executor) pair; this function answers it for the plan-forwarding executor.
 *
 * Do not widen the table to close that gap: a harness-keyed `true` would promise the intent to
 * every plan-forwarding caller, and those callers cannot deliver it. An executor that owns a
 * launcher control states so where it binds it — `materializeProfile`'s `binds` option in
 * `@tangle-network/agent-profile-materialize`, which turns the plan's refusal into a binding that
 * executor must then apply.
 *
 * Pass `undefined` when the harness is not known at declaration time: the answer is then
 * `{ replace: false, append: false }`, because an adapter that cannot name its harness cannot
 * promise either intent, and `false` means "refuse" rather than "silently substitute the other".
 * An adapter that forwards a profile to some other layer must still declare what that layer's
 * harness really does — being able to put the field on the wire is not the same as honoring it.
 */
export function harnessSystemPromptIntents(
  harness: HarnessType | undefined,
): AgentProfileSystemPromptCapability {
  if (!harness) return noSystemPromptControls;
  return harnessSystemPromptControls[harness] ?? noSystemPromptControls;
}
