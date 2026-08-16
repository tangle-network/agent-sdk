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
import type { AgentTerminalSession } from "./environment-terminal.js";
import { harnessTypeSchema } from "./harness.js";
import { agentProfileSchema } from "./profile-schema.js";
import {
  AgentExactRunControlRefSchema,
  type AgentExactRunControlRef,
} from "./runtime-control.js";

const INTERACTIVE_MAX_DIMENSION = 10_000;
const interactiveDimensionSchema = z
  .number()
  .int()
  .positive()
  .max(INTERACTIVE_MAX_DIMENSION);

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
 * Durable identity of one coding-agent TUI.
 *
 * This reference identifies the exact admitted run and effective profile.
 * It is not a generic shell id and cannot be used to create another process.
 */
export const AgentInteractiveSessionRefSchema = z.strictObject({
  run: AgentExactRunControlRefSchema,
  /** Canonical digest of the AgentProfile submitted by the caller. */
  requestedProfileDigest: sha256DigestSchema,
  /** Canonical digest of the effective profile the provider admitted. */
  admittedProfileDigest: sha256DigestSchema,
  /** Provider-issued identity of this exact process incarnation. */
  incarnationId: boundedIdentifierSchema,
  harness: harnessTypeSchema,
  startedAt: z.iso.datetime().max(64),
});
export type AgentInteractiveSessionRef = z.infer<
  typeof AgentInteractiveSessionRefSchema
>;

/** Start one native coding-agent TUI for an already admitted run. */
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

/** Geometry for one attachment to the existing coding-agent TUI. */
export const AgentInteractiveSessionAttachSchema = z.strictObject({
  cols: interactiveDimensionSchema.optional(),
  rows: interactiveDimensionSchema.optional(),
});
export type AgentInteractiveSessionAttach = z.infer<
  typeof AgentInteractiveSessionAttachSchema
>;

/** Provider-observed lifecycle of one native coding-agent TUI. */
export const AgentInteractiveSessionStatusSchema = z.discriminatedUnion(
  "state",
  [
    z.strictObject({
      state: z.literal("running"),
      ref: AgentInteractiveSessionRefSchema,
    }),
    z.strictObject({
      state: z.literal("exited"),
      ref: AgentInteractiveSessionRefSchema,
      endedAt: z.iso.datetime().max(64),
      reason: z.enum(["exited", "stopped", "lost"]),
      exitCode: z.number().int().optional(),
      exitSignal: boundedStringSchema.min(1).optional(),
    }),
    z.strictObject({
      state: z.literal("unknown"),
      ref: AgentInteractiveSessionRefSchema,
      message: boundedStringSchema.min(1),
      retryable: z.boolean(),
    }),
  ],
);
export type AgentInteractiveSessionStatus = z.infer<
  typeof AgentInteractiveSessionStatusSchema
>;

/**
 * Exact native TUI selected for one run.
 *
 * `attach` reaches the existing process. It never creates a shell or starts a
 * second coding-agent process. Detach and terminal close affect only the live
 * socket; `stop` terminates the provider-owned coding-agent process.
 */
export interface AgentInteractiveSession {
  readonly ref: AgentInteractiveSessionRef;
  status(options?: {
    signal?: AbortSignal;
  }): Promise<AgentInteractiveSessionStatus>;
  attach(
    request?: AgentInteractiveSessionAttach,
    options?: { signal?: AbortSignal },
  ): Promise<AgentTerminalSession>;
  sendPrompt?(
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  stop(options?: { signal?: AbortSignal }): Promise<AgentInteractiveSessionStatus>;
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

/** Prove that a provider returned the exact run, profile, and runner requested. */
export function agentInteractiveSessionRefMatchesStart(
  request: AgentInteractiveSessionStart,
  ref: AgentInteractiveSessionRef,
): boolean {
  const parsedRequest = AgentInteractiveSessionStartSchema.safeParse(request);
  const parsedRef = AgentInteractiveSessionRefSchema.safeParse(ref);
  if (!parsedRequest.success || !parsedRef.success) return false;
  const harness = parsedRequest.data.profile.harness;
  if (harness === undefined) return false;
  return (
    parsedRef.data.requestedProfileDigest ===
      parsedRequest.data.requestedProfileDigest &&
    parsedRef.data.harness === harness &&
    sameExactRun(parsedRef.data.run, parsedRequest.data.run)
  );
}

/** Prove that a status belongs to the handle that requested it. */
export function agentInteractiveSessionStatusMatchesRef(
  ref: AgentInteractiveSessionRef,
  status: AgentInteractiveSessionStatus,
): boolean {
  const parsedRef = AgentInteractiveSessionRefSchema.safeParse(ref);
  const parsedStatus = AgentInteractiveSessionStatusSchema.safeParse(status);
  if (!parsedRef.success || !parsedStatus.success) return false;
  const observed = parsedStatus.data.ref;
  return (
    observed.requestedProfileDigest === parsedRef.data.requestedProfileDigest &&
    observed.admittedProfileDigest === parsedRef.data.admittedProfileDigest &&
    observed.incarnationId === parsedRef.data.incarnationId &&
    observed.harness === parsedRef.data.harness &&
    observed.startedAt === parsedRef.data.startedAt &&
    sameExactRun(observed.run, parsedRef.data.run)
  );
}

function sameExactRun(
  left: AgentExactRunControlRef,
  right: AgentExactRunControlRef,
): boolean {
  return (
    left.runId === right.runId &&
    left.provider === right.provider &&
    left.environmentId === right.environmentId &&
    left.sessionId === right.sessionId &&
    left.executionId === right.executionId &&
    left.requestDigest === right.requestDigest
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
