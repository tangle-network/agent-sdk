import { z } from "zod";

/**
 * The execution runner for an agent — WHICH runtime materializes and runs an `AgentProfile`.
 *
 * Harness is an EXECUTION concern chosen by the caller/executor per run, NOT part of the portable
 * profile identity: the same `AgentProfile` (prompt/model/skills/tools/mcp/subagents) runs on any
 * harness. This is the single shared enum every layer references instead of keeping its own copy
 * (session control, the profile materializer, the cli-bridge backends, VB profile specs).
 *
 * `cli-base` is the router-backed mode — a plain multi-turn router call (a reviewer, a cheap judge,
 * a one-shot) with no full coding-agent harness. The rest are full agentic harnesses run in a
 * sandbox or locally via the CLI bridge.
 *
 * Some values are input aliases that collapse to a base runner (`claude`/`claudish` → `claude-code`,
 * `kimi` → `kimi-code`); normalize with {@link canonicalizeHarness} before keying per-runner config.
 */
export type HarnessType =
  | "claude-code"
  | "claude"
  | "claudish"
  | "nanoclaw"
  | "codex"
  | "opencode"
  | "kimi-code"
  | "kimi"
  | "pi"
  | "gemini"
  | "hermes"
  | "openclaw"
  | "amp"
  | "factory-droids"
  | "acp"
  | "cli-base";

/** Runtime validator for {@link HarnessType}. Kept in lockstep with the type by the drift guard below. */
export const harnessTypeSchema = z.enum([
  "claude-code",
  "claude",
  "claudish",
  "nanoclaw",
  "codex",
  "opencode",
  "kimi-code",
  "kimi",
  "pi",
  "gemini",
  "hermes",
  "openclaw",
  "amp",
  "factory-droids",
  "acp",
  "cli-base",
]);

/** Input alias → canonical base runner. Aliases accept legacy/shorthand harness names. */
export const harnessAliases: Partial<Record<HarnessType, HarnessType>> = {
  claude: "claude-code",
  claudish: "claude-code",
  kimi: "kimi-code",
};

/** Collapse an alias to its base runner (idempotent on canonical values). */
export function canonicalizeHarness(harness: HarnessType): HarnessType {
  return harnessAliases[harness] ?? harness;
}

// Compile-time drift guard: the Zod enum and the TS union must describe the same set, so adding a
// value to one without the other is a `tsc` error (the same pattern profile-schema.ts uses).
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _harnessSchemaMatchesType: MutuallyAssignable<
  z.infer<typeof harnessTypeSchema>,
  HarnessType
> = true;
void _harnessSchemaMatchesType;
