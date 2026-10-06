import { describe, expect, it } from "vitest";
import {
  harnessHonorsEffort,
  harnessHonorsModel,
  harnessHonorsSelectors,
  harnessModelExclusions,
  harnessModelSupport,
  harnessProviders,
  harnessReasoningEfforts,
  harnessSupportsModel,
  harnessSystemPromptIntents,
  modelProvider,
  nativeReasoningControl,
  preferredHarnessForModel,
  reasoningEffortsFor,
  resolveModelProvider,
  snapHarnessToModel,
  snapModelToHarness,
} from "./harness-capabilities.js";
import { harnessTypeSchema } from "./harness.js";
import { REASONING_EFFORTS } from "./agent-profile.js";

const CATALOG = [
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "moonshot/kimi-k2",
  "zai/glm-4.7",
];

describe("modelProvider", () => {
  it("extracts the provider prefix, or null for a bare id", () => {
    expect(modelProvider("anthropic/claude-opus-4-6")).toBe("anthropic");
    expect(modelProvider("openrouter/openai/gpt-5")).toBe("openrouter");
    expect(modelProvider("gemini-2.5-flash-lite")).toBeNull();
    expect(modelProvider("")).toBeNull();
  });
});

describe("harness ↔ model compatibility", () => {
  it("vendor-locked harnesses only accept their provider; router harnesses accept any", () => {
    expect(harnessSupportsModel("claude-code", "anthropic/claude-sonnet-4-6")).toBe(true);
    expect(harnessSupportsModel("claude-code", "openai/gpt-5")).toBe(false);
    expect(harnessSupportsModel("codex", "openai/gpt-5")).toBe(true);
    expect(harnessSupportsModel("codex", "anthropic/claude-sonnet-4-6")).toBe(false);
    expect(harnessSupportsModel("kimi-code", "moonshot/kimi-k2")).toBe(true);
    expect(harnessSupportsModel("opencode", "openai/gpt-5")).toBe(true);
  });

  it("nanoclaw is router-backed — it runs any provider", () => {
    expect(harnessProviders("nanoclaw")).toBeNull();
    expect(harnessSupportsModel("nanoclaw", "openai/gpt-5")).toBe(true);
    expect(harnessSupportsModel("nanoclaw", "anthropic/claude-sonnet-4-6")).toBe(true);
  });

  it("forge and cursor are router-backed multi-provider CLIs", () => {
    for (const harness of ["forge", "cursor"] as const) {
      expect(harnessProviders(harness)).toBeNull();
      expect(harnessSupportsModel(harness, "openai/gpt-5")).toBe(true);
      expect(harnessSupportsModel(harness, "anthropic/claude-sonnet-4-6")).toBe(true);
      // No provider lock means no snapping away from the caller's model.
      expect(snapHarnessToModel(harness, "zai/glm-4.7")).toBe(harness);
      expect(harnessHonorsSelectors(harness)).toBe(true);
    }
  });

  it("prime is router-backed and expresses the pi line's full thinking set", () => {
    expect(harnessProviders("prime")).toBeNull();
    expect(harnessSupportsModel("prime", "zai/glm-5.2")).toBe(true);
    expect(snapHarnessToModel("prime", "zai/glm-5.2")).toBe("prime");
    expect(harnessReasoningEfforts("prime")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ]);
  });

  it("a sentinel id with no resolvable provider is left to the harness", () => {
    expect(harnessSupportsModel("claude-code", "default")).toBe(true);
    expect(harnessSupportsModel("codex", "my-finetune")).toBe(true);
  });

  it("a bare catalog id resolves its provider before the lock applies", () => {
    expect(resolveModelProvider("claude-sonnet-5-5")).toBe("anthropic");
    expect(resolveModelProvider("gpt-5.5")).toBe("openai");
    expect(resolveModelProvider("o3")).toBe("openai");
    expect(resolveModelProvider("glm-5.3")).toBe("zai");
    expect(resolveModelProvider("gemini-2.5-flash-lite")).toBe("google");
    expect(resolveModelProvider("default")).toBeNull();
    expect(harnessSupportsModel("claude-code", "claude-sonnet-5-5")).toBe(true);
    expect(harnessSupportsModel("claude-code", "glm-5.3")).toBe(false);
    expect(harnessSupportsModel("codex", "gemini-2.5-flash-lite")).toBe(false);
    expect(preferredHarnessForModel("claude-sonnet-5-5")).toBe("claude-code");
  });

  it("a provider-lock refusal names the harness, the model and the providers it accepts", () => {
    const support = harnessModelSupport("claude-code", "glm-5.3");
    expect(support).toMatchObject({
      supported: false,
      model: "zai/glm-5.3",
      provider: "zai",
      allowedProviders: ["anthropic"],
    });
    expect(support.supported === false && support.message).toBe(
      "Harness claude-code runs only anthropic models, not zai/glm-5.3 (provider zai). " +
        "Choose a model whose id starts with anthropic/, or a harness that runs zai models, such as opencode.",
    );
  });
});

describe("measured harness × model exclusions", () => {
  it("refuses the pi pairs measured to fail on production, and keeps the pairs that passed", () => {
    const medium = { reasoningEffort: "medium" as const };
    expect(harnessSupportsModel("pi", "anthropic/claude-sonnet-5-5", medium)).toBe(false);
    expect(harnessSupportsModel("pi", "anthropic/claude-opus-5-5", medium)).toBe(false);
    expect(harnessSupportsModel("pi", "openai/gpt-5.6-luna", medium)).toBe(false);
    expect(harnessSupportsModel("pi", "google/gemini-3.8-flash", medium)).toBe(false);
    expect(harnessSupportsModel("pi", "openai/gpt-5.5", medium)).toBe(true);
    expect(harnessSupportsModel("pi", "zai/glm-5.3", medium)).toBe(true);
    for (const model of [
      "anthropic/claude-sonnet-5-5",
      "openai/gpt-5.6-luna",
      "google/gemini-3.8-flash",
      "zai/glm-5.3",
    ]) {
      expect(harnessSupportsModel("opencode", model, medium)).toBe(true);
    }
  });

  it("applies a reasoning-only exclusion only when a reasoning effort is requested", () => {
    expect(harnessSupportsModel("pi", "anthropic/claude-sonnet-5-5")).toBe(true);
    expect(
      harnessSupportsModel("pi", "anthropic/claude-sonnet-5-5", { reasoningEffort: "none" }),
    ).toBe(true);
    expect(harnessSupportsModel("pi", "openai/gpt-5.6-luna", { reasoningEffort: null })).toBe(true);
    expect(harnessSupportsModel("pi", "google/gemini-3.8-flash")).toBe(false);
  });

  it("matches bare catalog ids through their provider", () => {
    expect(harnessSupportsModel("pi", "claude-sonnet-5-5", { reasoningEffort: "high" })).toBe(false);
    expect(harnessSupportsModel("pi", "gemini-3.8-flash")).toBe(false);
  });

  it("names the measurement in the refusal", () => {
    const support = harnessModelSupport("pi", "anthropic/claude-sonnet-5-5", {
      reasoningEffort: "medium",
    });
    expect(support.supported).toBe(false);
    if (support.supported) return;
    expect(support.exclusion?.measuredOn).toBe("2026-10-05");
    expect(support.message).toContain(
      "Harness pi cannot run anthropic/claude-sonnet-5-5 with a reasoning effort",
    );
    expect(support.message).toContain("Remove model.reasoningEffort");
    expect(support.message).toContain("agent-dev-container/issues/9382");
  });

  it("every exclusion names a router-backed harness, a date and evidence", () => {
    for (const entry of harnessModelExclusions) {
      expect(harnessProviders(entry.harness)).toBeNull();
      expect(entry.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.evidence).toMatch(/^https:\/\//);
    }
  });

  it("preferredHarnessForModel maps a vendor provider to its native harness", () => {
    expect(preferredHarnessForModel("anthropic/claude-opus-4-6")).toBe("claude-code");
    expect(preferredHarnessForModel("openai/gpt-5")).toBe("codex");
    expect(preferredHarnessForModel("moonshot/kimi-k2")).toBe("kimi-code");
    expect(preferredHarnessForModel("zai/glm-4.7")).toBeNull();
    expect(preferredHarnessForModel("default")).toBeNull();
  });
});

describe("snapModelToHarness", () => {
  it("snaps an incompatible model to the harness's best catalog id (opus before sonnet)", () => {
    expect(snapModelToHarness("claude-code", "openai/gpt-5", CATALOG)).toBe("anthropic/claude-opus-4-6");
    expect(snapModelToHarness("codex", "anthropic/claude-sonnet-4-6", CATALOG)).toBe("openai/gpt-5");
    expect(snapModelToHarness("kimi-code", "openai/gpt-5", CATALOG)).toBe("moonshot/kimi-k2");
  });

  it("prefers the standard-frontier gpt over a mini variant despite lexical order", () => {
    expect(
      snapModelToHarness("codex", "anthropic/claude-opus-4-6", ["openai/gpt-5-mini", "openai/gpt-5"]),
    ).toBe("openai/gpt-5");
  });

  it("leaves an already-compatible model unchanged", () => {
    expect(snapModelToHarness("claude-code", "anthropic/claude-sonnet-4-6", CATALOG)).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(snapModelToHarness("opencode", "openai/gpt-5", CATALOG)).toBe("openai/gpt-5");
    expect(snapModelToHarness("nanoclaw", "openai/gpt-5", CATALOG)).toBe("openai/gpt-5");
  });

  it("returns the original id when the catalog holds nothing compatible", () => {
    expect(snapModelToHarness("claude-code", "openai/gpt-5", ["openai/gpt-5", "zai/glm-4.7"])).toBe(
      "openai/gpt-5",
    );
  });
});

describe("snapHarnessToModel", () => {
  it("adopts the model's native harness when the current one can't run it", () => {
    expect(snapHarnessToModel("claude-code", "openai/gpt-5")).toBe("codex");
    expect(snapHarnessToModel("codex", "anthropic/claude-opus-4-6")).toBe("claude-code");
    expect(snapHarnessToModel("claude-code", "moonshot/kimi-k2")).toBe("kimi-code");
  });

  it("keeps the harness when it already runs the model", () => {
    expect(snapHarnessToModel("claude-code", "anthropic/claude-opus-4-6")).toBe("claude-code");
    expect(snapHarnessToModel("nanoclaw", "openai/gpt-5")).toBe("nanoclaw");
  });

  it("falls back to opencode for a provider with no native harness", () => {
    expect(snapHarnessToModel("codex", "zai/glm-4.7")).toBe("opencode");
  });
});

describe("reasoning effort support", () => {
  it("offers each harness its real adapter set, not the generic ladder", () => {
    // no-thinking runners
    expect(harnessReasoningEfforts("cli-base")).toEqual(["none"]);
    // Explicit sets match each native CLI; model data narrows them later.
    // codex accepts `none` (thinking off) — the picker hid it for months while
    // the API enumerated it first.
    expect(harnessReasoningEfforts("codex")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ]);
    // pi's `--thinking` tops out at `max`, which canonical `ultracode` reaches.
    expect(harnessReasoningEfforts("pi")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ]);
    expect(harnessReasoningEfforts("openclaw")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ]);
    // claude: real `--effort` ladder low…max (ultracode stands in for max); no none/minimal
    expect(harnessReasoningEfforts("claude-code")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ]);
    // kimi: binary toggle (none = off, high = on)
    expect(harnessReasoningEfforts("kimi-code")).toEqual(["none", "high"]);
    // pass-through / router-driven: full ladder (narrowed later by the model)
    expect(harnessReasoningEfforts("opencode")).toContain("ultracode");
  });

  it("nanoclaw expresses only `none` (its runner sends no thinking flag)", () => {
    expect(harnessReasoningEfforts("nanoclaw")).toEqual(["none"]);
  });

  it("narrows by the model's own capability", () => {
    expect(reasoningEffortsFor("claude-code", { supportsReasoning: false })).toEqual(["none"]);
    // claude's set is low…ultracode; a model capped at `medium` trims the tail.
    expect(reasoningEffortsFor("claude-code", { maxEffort: "medium" })).toEqual([
      "low",
      "medium",
    ]);
    expect(reasoningEffortsFor("codex", { maxEffort: "high" })).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningEffortsFor("codex", { maxEffort: "ultracode" })).toEqual(
      harnessReasoningEfforts("codex"),
    );
  });
});

describe("per-turn selector support", () => {
  it("honors both selectors for the mainstream agent harnesses", () => {
    for (const h of ["opencode", "claude-code", "codex", "kimi-code"] as const) {
      expect(harnessHonorsModel(h)).toBe(true);
      expect(harnessHonorsEffort(h)).toBe(true);
      expect(harnessHonorsSelectors(h)).toBe(true);
    }
  });

  it("flags harnesses that drop the per-turn model", () => {
    for (const h of ["amp", "openclaw", "nanoclaw"] as const) {
      expect(harnessHonorsModel(h)).toBe(false);
    }
    expect(harnessHonorsModel("factory-droids")).toBe(true); // honors model, not effort
  });

  it("flags harnesses that drop the reasoning effort", () => {
    for (const h of ["amp", "factory-droids", "hermes", "nanoclaw", "acp"] as const) {
      expect(harnessHonorsEffort(h)).toBe(false);
    }
    expect(harnessHonorsEffort("openclaw")).toBe(true); // honors effort, not model
  });

  it("harnessHonorsSelectors is the AND of both", () => {
    expect(harnessHonorsSelectors("amp")).toBe(false);
    expect(harnessHonorsSelectors("factory-droids")).toBe(false); // model yes, effort no
    expect(harnessHonorsSelectors("openclaw")).toBe(false); // effort yes, model no
  });

});

describe("system-prompt intents", () => {
  it("gives each harness the intents its own controls execute, not the union", () => {
    // claude-code / pi own both: --system-prompt drops the built-in prompt,
    // --append-system-prompt keeps it and adds after it.
    expect(harnessSystemPromptIntents("claude-code")).toEqual({ replace: true, append: true });
    expect(harnessSystemPromptIntents("pi")).toEqual({ replace: true, append: true });
    // codex / gemini own replacement only (model_instructions_file, .gemini/system.md).
    expect(harnessSystemPromptIntents("codex")).toEqual({ replace: true, append: false });
    expect(harnessSystemPromptIntents("gemini")).toEqual({ replace: true, append: false });
    // opencode owns addition only: its replacement control binds to a launch-time agent.
    expect(harnessSystemPromptIntents("opencode")).toEqual({ replace: false, append: true });
  });

  it("refuses both for every harness with no system-prompt control of its own", () => {
    for (const h of [
      "nanoclaw",
      "kimi-code",
      "hermes",
      "openclaw",
      "amp",
      "factory-droids",
      "forge",
      "cursor",
      "acp",
      "cli-base",
    ] as const) {
      expect(harnessSystemPromptIntents(h)).toEqual({ replace: false, append: false });
    }
  });

  it("refuses both when the harness is unknown at declaration time", () => {
    // An adapter that cannot name its harness cannot promise either intent. `false` means
    // "refuse", never "substitute the other intent silently".
    expect(harnessSystemPromptIntents(undefined)).toEqual({ replace: false, append: false });
  });

  it("covers every harness in the union, so a new one refuses by default", () => {
    for (const h of harnessTypeSchema.options) {
      const intents = harnessSystemPromptIntents(h);
      expect(typeof intents.replace).toBe("boolean");
      expect(typeof intents.append).toBe("boolean");
    }
    // Exactly the measured owners, so widening the table is a deliberate edit here.
    const replacers = harnessTypeSchema.options.filter((h) => harnessSystemPromptIntents(h).replace);
    const appenders = harnessTypeSchema.options.filter((h) => harnessSystemPromptIntents(h).append);
    expect([...replacers].sort()).toEqual(["claude-code", "codex", "gemini", "pi", "prime"]);
    expect([...appenders].sort()).toEqual(["claude-code", "opencode", "pi", "prime"]);
  });
});

describe("nativeReasoningControl", () => {
  it("maps the ladder onto each harness's own control token", () => {
    // Pinned against the argv builders that spawn each CLI. A rung renamed upstream must be
    // changed here, where both the adapter and the receipt check read it.
    expect(REASONING_EFFORTS.map((e) => nativeReasoningControl("claude-code", e))).toEqual([
      "low", "low", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(REASONING_EFFORTS.map((e) => nativeReasoningControl("codex", e))).toEqual([
      "none", "minimal", "low", "medium", "high", "xhigh", "ultra",
    ]);
    expect(REASONING_EFFORTS.map((e) => nativeReasoningControl("pi", e))).toEqual([
      "off", "minimal", "low", "medium", "high", "xhigh", "xhigh",
    ]);
    expect(REASONING_EFFORTS.map((e) => nativeReasoningControl("prime", e))).toEqual([
      "off", "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(REASONING_EFFORTS.map((e) => nativeReasoningControl("kimi-code", e))).toEqual([
      "--no-thinking", "--no-thinking", "--no-thinking", null, "--thinking", "--thinking", "--thinking",
    ]);
    expect(REASONING_EFFORTS.map((e) => nativeReasoningControl("opencode", e))).toEqual([
      ...REASONING_EFFORTS,
    ]);
  });

  it("answers null for a harness that applies no native control", () => {
    // gemini derives thinking from the model, and the rest plumb no thinking flag. Asserting a
    // token for them refuses a legitimate run, which is why the default is `null`, not the request.
    for (const harness of harnessTypeSchema.options) {
      if (["claude-code", "codex", "pi", "prime", "kimi-code", "opencode"].includes(harness)) continue;
      for (const effort of REASONING_EFFORTS) {
        expect(nativeReasoningControl(harness, effort)).toBeNull();
      }
    }
  });

  it("applies no control when nothing was requested", () => {
    for (const harness of harnessTypeSchema.options) {
      expect(nativeReasoningControl(harness, null)).toBeNull();
    }
  });

  it("never claims a control for a harness whose runner drops the effort", () => {
    for (const harness of harnessTypeSchema.options) {
      if (harnessHonorsEffort(harness)) continue;
      for (const effort of REASONING_EFFORTS) {
        expect(nativeReasoningControl(harness, effort)).toBeNull();
      }
    }
  });
});
