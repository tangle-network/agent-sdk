import { z } from "zod";
import { boundedIdentifierSchema, boundedStringSchema } from "./contract-limits.js";

const TERMINAL_MAX_DIMENSION = 10_000;
const terminalDimensionSchema = z.number().int().positive().max(TERMINAL_MAX_DIMENSION);

/**
 * Provider-neutral handle for one interactive terminal.
 *
 * The handle carries no raw process id and no environment map, so a terminal
 * reference never leaks host process detail or injected secrets. Every terminal
 * is bound to a parent execution and carries an explicit expiry, so an orphan
 * or an expired terminal fails closed at the call sites that read it.
 */
export const TerminalSessionRefSchema = z.strictObject({
  terminalSessionId: boundedIdentifierSchema,
  parentExecutionId: boundedIdentifierSchema,
  name: boundedIdentifierSchema,
  shell: boundedStringSchema.min(1),
  command: boundedStringSchema.optional(),
  cwd: boundedStringSchema.min(1),
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
  connectionId: boundedIdentifierSchema.optional(),
  createdAt: z.iso.datetime().max(64),
  lastActivityAt: z.iso.datetime().max(64),
  expiresAt: z.iso.datetime().max(64),
  isRunning: z.boolean(),
  exitCode: z.number().int().optional(),
  exitSignal: boundedIdentifierSchema.optional(),
  attachCount: z.number().int().nonnegative(),
});
export type TerminalSessionRef = z.infer<typeof TerminalSessionRefSchema>;

/** Raw bytes written to the terminal, normalized to UTF-8 text. */
export const TerminalInputSchema = z.strictObject({
  data: boundedStringSchema,
});
export type TerminalInput = z.infer<typeof TerminalInputSchema>;

/** New terminal geometry. */
export const TerminalResizeSchema = z.strictObject({
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
});
export type TerminalResize = z.infer<typeof TerminalResizeSchema>;

/**
 * Create-or-reattach request. A present `terminalSessionId` reattaches to an
 * existing terminal; its absence opens a new one under the parent execution.
 * `mode` selects an `attach` to a live process or a `logical` resume that
 * replays retained output.
 */
export const TerminalAttachRequestSchema = z.strictObject({
  parentExecutionId: boundedIdentifierSchema,
  terminalSessionId: boundedIdentifierSchema.optional(),
  connectionId: boundedIdentifierSchema.optional(),
  mode: z.enum(["attach", "logical"]),
  cols: terminalDimensionSchema.optional(),
  rows: terminalDimensionSchema.optional(),
  command: boundedStringSchema.optional(),
  cwd: boundedStringSchema.optional(),
});
export type TerminalAttachRequest = z.infer<typeof TerminalAttachRequestSchema>;

/** Result of a create-or-reattach request. */
export const TerminalAttachResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.enum(["attached", "reattached"]),
    mode: z.enum(["attach", "logical"]),
    ref: TerminalSessionRefSchema,
    attachCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: boundedStringSchema.min(1),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    message: boundedStringSchema.min(1),
    retryable: z.boolean(),
  }),
]);
export type TerminalAttachResult = z.infer<typeof TerminalAttachResultSchema>;

/**
 * One ordered terminal output frame. `output` frames carry a monotonic `seq`
 * that a consumer replays from, so a reconnect resumes without loss or
 * duplication.
 */
export const TerminalOutputEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    cols: terminalDimensionSchema.optional(),
    rows: terminalDimensionSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("output"),
    seq: z.number().int().nonnegative(),
    data: boundedStringSchema,
  }),
  z.strictObject({
    type: z.literal("resize"),
    cols: terminalDimensionSchema,
    rows: terminalDimensionSchema,
  }),
  z.strictObject({
    type: z.literal("exit"),
    exitCode: z.number().int().optional(),
    exitSignal: boundedIdentifierSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("error"),
    message: boundedStringSchema.min(1),
  }),
]);
export type TerminalOutputEvent = z.infer<typeof TerminalOutputEventSchema>;

/** Acknowledgement of a detach or close. */
export const TerminalDetachAckSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("detached"),
    terminalSessionId: boundedIdentifierSchema,
    connectionId: boundedIdentifierSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("closed"),
    terminalSessionId: boundedIdentifierSchema,
    exitCode: z.number().int().optional(),
    exitSignal: boundedIdentifierSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    terminalSessionId: boundedIdentifierSchema,
    message: boundedStringSchema.min(1),
    retryable: z.boolean(),
  }),
]);
export type TerminalDetachAck = z.infer<typeof TerminalDetachAckSchema>;

/**
 * Fail-closed usability check for a terminal reference. Returns true only when
 * the reference parses, is running, and its expiry is in the future. A parse
 * failure, a stopped terminal, or a past expiry denies use.
 */
export function terminalSessionUsable(
  ref: TerminalSessionRef,
  nowIso: string,
): boolean {
  const parsed = TerminalSessionRefSchema.safeParse(ref);
  if (!parsed.success) return false;
  const now = Date.parse(nowIso);
  const expiresAt = Date.parse(parsed.data.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) return false;
  if (now >= expiresAt) return false;
  return parsed.data.isRunning;
}

/** Bind an attach result to the parent execution and terminal it targeted. */
export function terminalAttachResultMatchesRequest(
  request: TerminalAttachRequest,
  result: TerminalAttachResult,
): boolean {
  const parsedRequest = TerminalAttachRequestSchema.safeParse(request);
  const parsedResult = TerminalAttachResultSchema.safeParse(result);
  if (!parsedRequest.success || !parsedResult.success) return false;
  const outcome = parsedResult.data;
  if (outcome.status !== "attached" && outcome.status !== "reattached") {
    return false;
  }
  if (outcome.mode !== parsedRequest.data.mode) return false;
  if (outcome.ref.parentExecutionId !== parsedRequest.data.parentExecutionId) {
    return false;
  }
  if (
    parsedRequest.data.terminalSessionId !== undefined &&
    outcome.ref.terminalSessionId !== parsedRequest.data.terminalSessionId
  ) {
    return false;
  }
  return true;
}

/**
 * Live handle for one interactive terminal. Signatures only; a provider adapter
 * binds the transport in phase two.
 */
export interface AgentTerminalSession {
  readonly ref: TerminalSessionRef;
  input(input: TerminalInput, options?: { signal?: AbortSignal }): Promise<void>;
  resize(resize: TerminalResize, options?: { signal?: AbortSignal }): Promise<void>;
  detach(options?: { signal?: AbortSignal }): Promise<TerminalDetachAck>;
  close(options?: { signal?: AbortSignal }): Promise<TerminalDetachAck>;
  /** Replays retained frames from `since`, then continues until the terminal exits. */
  events(options?: {
    since?: number;
    signal?: AbortSignal;
  }): AsyncIterable<TerminalOutputEvent>;
}
