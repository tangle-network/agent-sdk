import { z } from "zod";

/**
 * Recognized execution identities, not a deployment's list of installed runners.
 * A profile's authored harness remains part of its canonical identity; execution
 * receipts record authored identity, effective identity and selected harness
 * separately. Retiring an executable must not invalidate historical profiles,
 * sessions or receipts. Availability is admitted against the selected deployment.
 *
 * `cli-base` names router-backed execution without a full coding-agent harness.
 * `prime` is a distinct Pi-line fork with a different native wire protocol; its
 * sessions are not interchangeable with Pi sessions. A shared identity does not
 * assert protocol, model, profile-control or native-resume compatibility.
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
  "forge",
  "cursor",
  "acp",
  "cli-base",
]);

/** One declaration owns runtime validation and the compile-time vocabulary. */
export type HarnessType = z.infer<typeof harnessTypeSchema>;
