import { describe, expect, it } from "vitest";
import {
  harnessHonorsEffort,
  harnessHonorsModel,
  harnessHonorsSelectors,
  harnessProviders,
  harnessReasoningEfforts,
  harnessSupportsModel,
  modelProvider,
  preferredHarnessForModel,
  reasoningEffortsFor,
  snapHarnessToModel,
  snapModelToHarness,
} from "./harness-capabilities.js";

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

  it("aliases resolve to their base runner's lock", () => {
    expect(harnessSupportsModel("claude", "openai/gpt-5")).toBe(false);
    expect(harnessSupportsModel("kimi", "moonshot/kimi-k2")).toBe(true);
  });

  it("nanoclaw is router-backed — it runs any provider", () => {
    expect(harnessProviders("nanoclaw")).toBeNull();
    expect(harnessSupportsModel("nanoclaw", "openai/gpt-5")).toBe(true);
    expect(harnessSupportsModel("nanoclaw", "anthropic/claude-sonnet-4-6")).toBe(true);
  });

  it("provider-less / sentinel ids are compatible everywhere", () => {
    expect(harnessSupportsModel("claude-code", "default")).toBe(true);
    expect(harnessSupportsModel("codex", "gemini-2.5-flash-lite")).toBe(true);
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
    // clamp-based: `none` dropped (inert ≡ auto); capped at the adapter's real ceiling
    expect(harnessReasoningEfforts("codex")).toEqual(["minimal", "low", "medium", "high"]);
    expect(harnessReasoningEfforts("pi")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(harnessReasoningEfforts("openclaw")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    // claude: real `--effort` ladder low…max (ultracode stands in for max); no none/minimal
    expect(harnessReasoningEfforts("claude-code")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ]);
    // kimi: binary toggle (minimal = off, high = on)
    expect(harnessReasoningEfforts("kimi-code")).toEqual(["minimal", "high"]);
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
    // model ceiling above the harness ceiling can't widen it
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

  it("resolves aliases before keying", () => {
    // `claude` canonicalizes to `claude-code`, which honors both.
    expect(harnessHonorsSelectors("claude")).toBe(true);
  });
});
