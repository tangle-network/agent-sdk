import { z } from "zod";

/**
 * Harness identities accepted for new profiles and execution requests.
 * A deployment admits only the runners it implements.
 *
 * `cli-base` names router-backed execution without a full coding-agent harness.
 * `prime` is a distinct Pi-line fork. A shared identity does not assert protocol compatibility.
 */
export const harnessTypeSchema = z.enum([
  "claude-code",
  "nanoclaw",
  "codex",
  "opencode",
  "kimi-code",
  "pi",
  "prime",
  "gemini",
  "hermes",
  "openclaw",
  "amp",
  "factory-droids",
  "cursor",
  "grok",
  "nanocode",
  "exo",
  "acp",
  "cli-base",
]);

/** One declaration owns runtime validation and the compile-time vocabulary. */
export type HarnessType = z.infer<typeof harnessTypeSchema>;

/** Immutable evidence can retain an identity retired from new execution. */
export const recordedHarnessTypeSchema = z.enum([...harnessTypeSchema.options, "forge"]);
export type RecordedHarnessType = z.infer<typeof recordedHarnessTypeSchema>;

/** Command spellings resolve to canonical identities; authored profile schemas stay strict. */
export function resolveHarnessType(value: string): HarnessType | null {
  const parsed = harnessTypeSchema.safeParse(value === "claude" ? "claude-code" : value === "kimi" ? "kimi-code" : value);
  return parsed.success ? parsed.data : null;
}
