import { z } from "zod";

/**
 * The execution runner for an agent — WHICH runtime materializes and runs an `AgentProfile`.
 *
 * This enum describes an EXECUTION concern. When an `AgentProfile` authors a `harness`
 * preference, that field participates in its canonical identity like every other parsed profile
 * field. A caller or executor may override the preference for one run, but the execution receipt
 * preserves the authored identity, effective identity, and selected harness separately. This is
 * the single shared enum every layer references instead of keeping its own copy (session control,
 * the profile materializer, the cli-bridge backends, VB profile specs).
 *
 * `cli-base` is the router-backed mode — a plain multi-turn router call (a reviewer, a cheap judge,
 * a one-shot) with no full coding-agent harness. The rest are full agentic harnesses run in a
 * sandbox or locally via the CLI bridge.
 *
 * `forge` (tailcallhq/forgecode) and `cursor` (cursor-agent) are multi-provider CLI harnesses with
 * no vendor lock, so they carry no entry in the capability tables and resolve as router-backed.
 */
export type HarnessType =
  | "claude-code"
  | "nanoclaw"
  | "codex"
  | "opencode"
  | "kimi-code"
  | "pi"
  | "gemini"
  | "hermes"
  | "openclaw"
  | "amp"
  | "factory-droids"
  | "forge"
  | "cursor"
  | "acp"
  | "cli-base";

/** Runtime validator for {@link HarnessType}. Kept in lockstep with the type by the drift guard below. */
export const harnessTypeSchema = z.enum([
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
]);

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
