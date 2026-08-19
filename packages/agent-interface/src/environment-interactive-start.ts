import { z } from "zod";
import {
  canonicalCandidateDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import type { AgentProfile } from "./agent-profile.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import {
  boundedIdentifierSchema,
  boundedStringSchema,
} from "./contract-limits.js";
import {
  type AgentInteractiveSessionRef,
  AgentInteractiveSessionRefSchema,
} from "./environment-interactive-control.js";
import {
  agentInteractiveDimensionSchema as interactiveDimensionSchema,
  sameAgentExactRun as sameExactRun,
} from "./environment-interactive-shared.js";
import { agentProfileSchema } from "./profile-schema.js";
import {
  AgentExactRunControlRefSchema,
  type AgentExactRunControlRef,
} from "./runtime-control.js";

const AgentInteractiveSessionRunCoordinatesSchema = z.strictObject({
  provider: boundedIdentifierSchema,
  environmentId: boundedIdentifierSchema,
  sessionId: boundedIdentifierSchema,
  executionId: boundedIdentifierSchema,
});
export type AgentInteractiveSessionRunCoordinates = z.infer<
  typeof AgentInteractiveSessionRunCoordinatesSchema
>;

/**
 * Start one native coding-agent TUI from caller-owned request material.
 *
 * The provider owns profile materialization and returns its preparation receipt
 * in the resulting reference. Replaying the same exact request/run returns the
 * same reference, even after the process exits; changed material cannot reuse it.
 */
export const AgentInteractiveSessionStartSchema = z.strictObject({
  run: AgentExactRunControlRefSchema,
  profile: agentProfileSchema,
  requestedProfileDigest: sha256DigestSchema,
  initialPrompt: boundedStringSchema.optional(),
  cwd: boundedStringSchema.min(1).optional(),
  cols: interactiveDimensionSchema.optional(),
  rows: interactiveDimensionSchema.optional(),
});
export type AgentInteractiveSessionStart = z.infer<
  typeof AgentInteractiveSessionStartSchema
>;

export type AgentInteractiveSessionStartInput = Omit<
  AgentInteractiveSessionStart,
  "run"
>;

/** Digest the exact process-start request independently of its derived run id. */
export function agentInteractiveSessionRequestDigest(
  coordinates: AgentInteractiveSessionRunCoordinates,
  input: AgentInteractiveSessionStartInput,
): `sha256:${string}` {
  const exactCoordinates = AgentInteractiveSessionRunCoordinatesSchema.parse(
    coordinates,
  );
  const exactInput = AgentInteractiveSessionStartSchema.omit({ run: true }).parse(
    input,
  );
  return canonicalCandidateDigest({
    kind: "agent-interactive-session-start.v1",
    run: exactCoordinates,
    requestedProfileDigest: exactInput.requestedProfileDigest,
    ...(exactInput.initialPrompt === undefined
      ? {}
      : { initialPrompt: exactInput.initialPrompt }),
    ...(exactInput.cwd === undefined ? {} : { cwd: exactInput.cwd }),
    ...(exactInput.cols === undefined ? {} : { cols: exactInput.cols }),
    ...(exactInput.rows === undefined ? {} : { rows: exactInput.rows }),
  });
}

/** Mint the one exact run reference a provider must acknowledge for this start. */
export function agentInteractiveSessionRunRef(
  coordinates: AgentInteractiveSessionRunCoordinates,
  input: AgentInteractiveSessionStartInput,
): AgentExactRunControlRef {
  const exactCoordinates = AgentInteractiveSessionRunCoordinatesSchema.parse(
    coordinates,
  );
  const requestDigest = agentInteractiveSessionRequestDigest(
    exactCoordinates,
    input,
  );
  return AgentExactRunControlRefSchema.parse({
    ...exactCoordinates,
    runId: `interactive-run-${requestDigest.slice("sha256:".length)}`,
    requestDigest,
  });
}

/** Parse a start request and prove its profile identity before provider work. */
export function exactAgentInteractiveSessionStart(
  value: AgentInteractiveSessionStart,
): AgentInteractiveSessionStart {
  const parsed = AgentInteractiveSessionStartSchema.parse(value);
  if (parsed.profile.harness === undefined) {
    throw new Error("interactive agent sessions require AgentProfile.harness");
  }
  const digest = canonicalAgentProfileDigest(parsed.profile as AgentProfile);
  if (digest !== parsed.requestedProfileDigest) {
    throw new Error(
      "interactive agent session requested profile digest does not match its profile",
    );
  }
  const { run, ...input } = parsed;
  const expectedRun = agentInteractiveSessionRunRef(runCoordinates(run), input);
  if (!sameExactRun(run, expectedRun)) {
    throw new Error(
      "interactive agent session run identity does not match its start request",
    );
  }
  return parsed;
}

/** Prove that a provider returned the exact run and preparation receipt requested. */
export function agentInteractiveSessionRefMatchesStart(
  request: AgentInteractiveSessionStart,
  ref: AgentInteractiveSessionRef,
): boolean {
  const parsedRequest = AgentInteractiveSessionStartSchema.safeParse(request);
  const parsedRef = AgentInteractiveSessionRefSchema.safeParse(ref);
  if (!parsedRequest.success || !parsedRef.success) return false;
  const requestedHarness = parsedRequest.data.profile.harness;
  if (requestedHarness === undefined) return false;
  return (
    parsedRef.data.preparationReceipt.authoredProfileDigest ===
      parsedRequest.data.requestedProfileDigest &&
    parsedRef.data.preparationReceipt.harness === requestedHarness &&
    sameExactRun(parsedRef.data.run, parsedRequest.data.run)
  );
}

function runCoordinates(
  run: AgentExactRunControlRef,
): AgentInteractiveSessionRunCoordinates {
  return {
    provider: run.provider,
    environmentId: run.environmentId,
    sessionId: run.sessionId,
    executionId: run.executionId,
  };
}
