import { z } from "zod";

const canonicalSha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u);

/** Exact receipt for one Runtime/controller prompt accepted by a native provider session. */
export interface AgentControllerTurnReceipt {
  /** One-based native provider prompt ordinal within the session. */
  readonly ordinal: number;
  /** Runtime/provider execution identity sent to the adapter. */
  readonly runId: string;
  /** Exact X-Run-Request-Digest value returned by CLI Bridge. */
  readonly bridgeRequestDigest: string;
  /** SHA-256 of the exact native provider user-prompt UTF-8 bytes. */
  readonly promptSha256: `sha256:${string}`;
  /** Provider request interval start as Unix milliseconds. */
  readonly startedAt: number;
  /** Provider request interval end as Unix milliseconds. */
  readonly endedAt: number;
}

/**
 * Portable locator for one provider-native session plus its ordered controller turns.
 *
 * `provider` identifies the configured adapter, while `backend` identifies the native
 * harness selected inside that adapter, for example `cli-bridge` plus `pi`.
 */
export interface AgentProviderSessionRef {
  readonly provider: string;
  readonly backend: string;
  readonly externalId: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
  /** Total native prompts approved for this session, including unhashed multipart prompts. */
  readonly nativePromptCount: number;
  /**
   * Strictly increasing by native prompt ordinal.
   * Empty means the native session is located but exact prompt bytes were unavailable.
   */
  readonly controllerTurns: readonly AgentControllerTurnReceipt[];
}

export const agentControllerTurnReceiptSchema = z
  .object({
    ordinal: z.number().int().positive(),
    runId: z.string().min(1),
    bridgeRequestDigest: canonicalSha256Schema,
    promptSha256: canonicalSha256Schema,
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (receipt.endedAt < receipt.startedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "controller turn endedAt must be at or after startedAt",
      });
    }
  });

export const agentProviderSessionRefSchema = z
  .object({
    provider: z.string().min(1),
    backend: z.string().min(1),
    externalId: z.string().min(1),
    nativeSessionId: z.string().min(1),
    cwd: z.string().min(1),
    nativePromptCount: z.number().int().positive(),
    controllerTurns: z.array(agentControllerTurnReceiptSchema),
  })
  .strict()
  .superRefine((session, ctx) => {
    let previousOrdinal = 0;
    let previousEndedAt = 0;
    const runIds = new Set<string>();
    for (const [index, receipt] of session.controllerTurns.entries()) {
      if (receipt.ordinal <= previousOrdinal) {
        ctx.addIssue({
          code: "custom",
          path: ["controllerTurns", index, "ordinal"],
          message: "controller turns must be strictly ordered by native prompt ordinal",
        });
      }
      if (receipt.ordinal > session.nativePromptCount) {
        ctx.addIssue({
          code: "custom",
          path: ["controllerTurns", index, "ordinal"],
          message: "controller turn ordinal exceeds nativePromptCount",
        });
      }
      if (runIds.has(receipt.runId)) {
        ctx.addIssue({
          code: "custom",
          path: ["controllerTurns", index, "runId"],
          message: "controller turn runId must be unique within a provider session",
        });
      }
      if (index > 0 && receipt.startedAt < previousEndedAt) {
        ctx.addIssue({
          code: "custom",
          path: ["controllerTurns", index, "startedAt"],
          message: "controller turn intervals must not overlap",
        });
      }
      previousOrdinal = receipt.ordinal;
      previousEndedAt = receipt.endedAt;
      runIds.add(receipt.runId);
    }
  });

/**
 * Detach, validate once, and recursively freeze a provider-native session at intake.
 * The returned value shares no mutable alias with provider-owned response objects.
 */
export function snapshotAgentProviderSessionRef(value: unknown): AgentProviderSessionRef {
  const parsed = agentProviderSessionRefSchema.parse(structuredClone(value));
  return deepFreeze(parsed) as AgentProviderSessionRef;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
