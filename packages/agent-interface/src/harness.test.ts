import { describe, expect, it } from "vitest";
import { type HarnessType, harnessTypeSchema } from "./harness.js";

/**
 * `harnessTypeSchema.options` is the list downstream packages derive their own
 * runner enums from (agent-dev-container's `BACKEND_TYPE`, agent-app's
 * `KNOWN_HARNESSES`). Pinning it here makes an accidental add/remove a failing
 * test in the owning package rather than a silent behavior change three repos
 * away.
 *
 * `forge` (tailcallhq/forgecode) and `cursor` (cursor-agent) ship provider
 * adapters downstream; their absence here is what forced those packages to keep
 * divergent copies of the enum.
 */
const CANONICAL_HARNESSES = [
  "claude-code",
  "nanoclaw",
  "codex",
  "opencode",
  "kimi-code",
  "pi",
  "gemini",
  "hermes",
  "openclaw",
  "amp",
  "factory-droids",
  "forge",
  "cursor",
  "acp",
  "cli-base",
] as const satisfies readonly HarnessType[];

describe("harnessTypeSchema", () => {
  it("is the canonical harness set downstream enums derive from", () => {
    expect([...harnessTypeSchema.options].sort()).toEqual(
      [...CANONICAL_HARNESSES].sort(),
    );
  });

  it("accepts every canonical id and rejects an unknown runner", () => {
    for (const harness of CANONICAL_HARNESSES) {
      expect(harnessTypeSchema.parse(harness)).toBe(harness);
    }
    expect(harnessTypeSchema.safeParse("not-a-harness").success).toBe(false);
  });
});
