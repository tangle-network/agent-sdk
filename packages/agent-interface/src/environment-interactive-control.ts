import { z } from "zod";
import {
  canonicalCandidateDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import {
  agentExecutionPreparationReceiptSchema,
} from "./agent-execution-preparation-receipt.js";
import {
  boundedIdentifierSchema,
  boundedStringSchema,
} from "./contract-limits.js";
import {
  agentInteractiveDimensionSchema as interactiveDimensionSchema,
  sameAgentExactRun as sameExactRun,
} from "./environment-interactive-shared.js";
import type { AgentTerminalSession } from "./environment-terminal.js";
import { AgentExactRunControlRefSchema } from "./runtime-control.js";

/**
 * Durable identity of one coding-agent TUI.
 *
 * This reference identifies the exact admitted run and preparation receipt.
 * It is not a generic shell id and cannot be used to create another process.
 */
export const AgentInteractiveSessionRefSchema = z.strictObject({
  run: AgentExactRunControlRefSchema,
  /** Canonical executor receipt containing the effective route and its proof. */
  preparationReceipt: agentExecutionPreparationReceiptSchema,
  /** Provider-issued identity of this exact process incarnation. */
  incarnationId: boundedIdentifierSchema,
  startedAt: z.iso.datetime().max(64),
});
export type AgentInteractiveSessionRef = z.infer<
  typeof AgentInteractiveSessionRefSchema
>;

/**
 * Provider-issued write authority for one exact interactive process.
 *
 * Expiry blocks mutations but does not kill the coding process. A coordinator
 * can issue a new compare-and-swap claim after expiry. The provider's PTY owner
 * lease remains the separate process-cleanup authority.
 */
export const AgentInteractiveSessionControlClaimSchema = z.strictObject({
  /** Canonical identity of the process ref this authority can mutate. */
  refDigest: sha256DigestSchema,
  /** Provider generation. A recovered coordinator must obtain a greater value. */
  generation: z.number().int().positive().safe(),
  /** Provider lease identity for this generation. */
  leaseId: boundedIdentifierSchema,
  /** Stable identity of the coordinator holding this lease. */
  holderId: boundedIdentifierSchema,
  expiresAt: z.iso.datetime().max(64),
});
export type AgentInteractiveSessionControlClaim = z.infer<
  typeof AgentInteractiveSessionControlClaimSchema
>;

export interface AgentInteractiveSessionControlClaimRequestMaterial {
  operationId: string;
  ref: AgentInteractiveSessionRef;
  holderId: string;
  /** Compare-and-swap value. Use zero when no coordinator currently holds a claim. */
  expectedGeneration: number;
}

const AgentInteractiveSessionControlClaimRequestMaterialSchema = z.strictObject({
  operationId: boundedIdentifierSchema,
  ref: AgentInteractiveSessionRefSchema,
  holderId: boundedIdentifierSchema,
  expectedGeneration: z.number().int().nonnegative().safe(),
});

export interface AgentInteractiveSessionControlClaimRequest
  extends AgentInteractiveSessionControlClaimRequestMaterial {
  requestDigest: `sha256:${string}`;
}

export function agentInteractiveSessionControlClaimRequestDigest(
  value: AgentInteractiveSessionControlClaimRequestMaterial,
): `sha256:${string}` {
  const parsed = AgentInteractiveSessionControlClaimRequestMaterialSchema.parse(
    value,
  );
  return canonicalCandidateDigest({
    kind: "agent-interactive-session-control-claim.v1",
    operationId: parsed.operationId,
    ref: parsed.ref,
    holderId: parsed.holderId,
    expectedGeneration: parsed.expectedGeneration,
  });
}

export const AgentInteractiveSessionControlClaimRequestSchema = z
  .strictObject({
    ...AgentInteractiveSessionControlClaimRequestMaterialSchema.shape,
    requestDigest: sha256DigestSchema,
  })
  .superRefine((request, refinement) => {
    const { requestDigest: _requestDigest, ...material } = request;
    if (
      request.requestDigest !==
      agentInteractiveSessionControlClaimRequestDigest(material)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message:
          "interactive session control claim request digest does not match its content",
      });
    }
  }) satisfies z.ZodType<AgentInteractiveSessionControlClaimRequest>;

export interface AgentInteractiveSessionControlClaimAcknowledgement {
  operationId: string;
  requestDigest: `sha256:${string}`;
  ref: AgentInteractiveSessionRef;
  status: "accepted" | "replayed" | "conflict" | "unknown";
  control?: AgentInteractiveSessionControlClaim;
  /** Why a provider rejected this claim request. */
  conflictReason?:
    | "generation_mismatch"
    | "operation_reuse";
  /** Current non-secret generation for a compare-and-swap conflict. */
  currentGeneration?: number;
  /** Present when this operation id already names different material. */
  existingRequestDigest?: `sha256:${string}`;
  message?: string;
  retryable?: boolean;
}

export const AgentInteractiveSessionControlClaimAcknowledgementSchema = z
  .strictObject({
    operationId: boundedIdentifierSchema,
    requestDigest: sha256DigestSchema,
    ref: AgentInteractiveSessionRefSchema,
    status: z.enum(["accepted", "replayed", "conflict", "unknown"]),
    control: AgentInteractiveSessionControlClaimSchema.optional(),
    conflictReason: z
      .enum(["generation_mismatch", "operation_reuse"])
      .optional(),
    currentGeneration: z.number().int().nonnegative().safe().optional(),
    existingRequestDigest: sha256DigestSchema.optional(),
    message: boundedStringSchema.min(1).optional(),
    retryable: z.boolean().optional(),
  })
  .superRefine((acknowledgement, refinement) => {
    const hasControl = acknowledgement.control !== undefined;
    if (
      (acknowledgement.status === "accepted" ||
        acknowledgement.status === "replayed") &&
      !hasControl
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["control"],
        message: "an accepted control claim must return its provider claim",
      });
    }
    if (
      acknowledgement.status !== "accepted" &&
      acknowledgement.status !== "replayed" &&
      hasControl
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["control"],
        message: "only an accepted or replayed claim may return control",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.conflictReason === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["conflictReason"],
        message:
          "a control claim conflict must distinguish generation mismatch from operation reuse",
      });
    }
    if (
      acknowledgement.status !== "conflict" &&
      acknowledgement.conflictReason !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["conflictReason"],
        message: "only a control claim conflict may report a conflict reason",
      });
    }
    if (
      hasControl &&
      !agentInteractiveSessionControlClaimMatchesRef(
        acknowledgement.ref,
        acknowledgement.control!,
      )
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["control", "refDigest"],
        message: "interactive control claim acknowledgement does not match its process ref",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.currentGeneration === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["currentGeneration"],
        message: "a control claim conflict must report the current generation",
      });
    }
    if (
      acknowledgement.conflictReason === "generation_mismatch" &&
      acknowledgement.existingRequestDigest !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message:
          "a generation mismatch must not be reported as operation reuse",
      });
    }
    if (
      acknowledgement.conflictReason === "operation_reuse" &&
      acknowledgement.existingRequestDigest === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message:
          "operation reuse must report the digest already stored for this operation",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.existingRequestDigest === acknowledgement.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a control claim conflict must identify different request material",
      });
    }
    if (
      acknowledgement.status !== "conflict" &&
      (acknowledgement.currentGeneration !== undefined ||
        acknowledgement.existingRequestDigest !== undefined)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["currentGeneration"],
        message: "only a control claim conflict may report existing generation state",
      });
    }
    if (
      acknowledgement.status === "unknown" &&
      (acknowledgement.message === undefined || acknowledgement.retryable !== true)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["retryable"],
        message:
          "an unknown control claim outcome must explicitly permit safe same-operation retry",
      });
    }
  }) satisfies z.ZodType<AgentInteractiveSessionControlClaimAcknowledgement>;

export function agentInteractiveSessionControlClaimAcknowledgementMatchesRequest(
  request: AgentInteractiveSessionControlClaimRequest,
  acknowledgement: AgentInteractiveSessionControlClaimAcknowledgement,
): boolean {
  const exactRequest = AgentInteractiveSessionControlClaimRequestSchema.safeParse(
    request,
  );
  const exactAcknowledgement =
    AgentInteractiveSessionControlClaimAcknowledgementSchema.safeParse(
      acknowledgement,
    );
  if (!exactRequest.success || !exactAcknowledgement.success) return false;
  return (
    exactAcknowledgement.data.operationId === exactRequest.data.operationId &&
    exactAcknowledgement.data.requestDigest === exactRequest.data.requestDigest &&
    canonicalCandidateDigest(exactAcknowledgement.data.ref) ===
      canonicalCandidateDigest(exactRequest.data.ref)
  );
}

/** Bind a provider-issued control claim to the exact process it can mutate. */
export function agentInteractiveSessionControlClaimMatchesRef(
  ref: AgentInteractiveSessionRef,
  claim: AgentInteractiveSessionControlClaim,
): boolean {
  const parsedRef = AgentInteractiveSessionRefSchema.safeParse(ref);
  const parsedClaim = AgentInteractiveSessionControlClaimSchema.safeParse(claim);
  return (
    parsedRef.success &&
    parsedClaim.success &&
    parsedClaim.data.refDigest === canonicalCandidateDigest(parsedRef.data)
  );
}

/** Compare two claims for one process without making a provider state claim. */
export function agentInteractiveSessionControlClaimIsNewer(
  candidate: AgentInteractiveSessionControlClaim,
  current: AgentInteractiveSessionControlClaim,
): boolean {
  const parsedCandidate = AgentInteractiveSessionControlClaimSchema.safeParse(
    candidate,
  );
  const parsedCurrent = AgentInteractiveSessionControlClaimSchema.safeParse(
    current,
  );
  return (
    parsedCandidate.success &&
    parsedCurrent.success &&
    parsedCandidate.data.refDigest === parsedCurrent.data.refDigest &&
    parsedCandidate.data.generation > parsedCurrent.data.generation
  );
}

/** Geometry for one attachment to the existing coding-agent TUI. */
export const AgentInteractiveSessionAttachSchema = z.strictObject({
  /** Required because the returned terminal permits input and resize. */
  control: AgentInteractiveSessionControlClaimSchema,
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

export interface AgentInteractiveSessionStopCommandMaterial {
  operationId: string;
  ref: AgentInteractiveSessionRef;
  control: AgentInteractiveSessionControlClaim;
}

const AgentInteractiveSessionStopCommandMaterialSchema = z
  .strictObject({
    operationId: boundedIdentifierSchema,
    ref: AgentInteractiveSessionRefSchema,
    control: AgentInteractiveSessionControlClaimSchema,
  })
  .superRefine((command, refinement) => {
    if (!agentInteractiveSessionControlClaimMatchesRef(command.ref, command.control)) {
      refinement.addIssue({
        code: "custom",
        path: ["control", "refDigest"],
        message: "interactive stop control claim does not match its process ref",
      });
    }
  });

export interface AgentInteractiveSessionStopCommand
  extends AgentInteractiveSessionStopCommandMaterial {
  requestDigest: `sha256:${string}`;
}

export function agentInteractiveSessionStopRequestDigest(
  value: AgentInteractiveSessionStopCommandMaterial,
): `sha256:${string}` {
  const parsed = AgentInteractiveSessionStopCommandMaterialSchema.parse(value);
  return canonicalCandidateDigest({
    kind: "agent-interactive-session-stop.v1",
    operationId: parsed.operationId,
    ref: parsed.ref,
    control: parsed.control,
  });
}

export const AgentInteractiveSessionStopCommandSchema = z
  .strictObject({
    ...AgentInteractiveSessionStopCommandMaterialSchema.shape,
    requestDigest: sha256DigestSchema,
  })
  .superRefine((command, refinement) => {
    const { requestDigest: _requestDigest, ...material } = command;
    if (
      command.requestDigest !==
      agentInteractiveSessionStopRequestDigest(material)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "interactive stop request digest does not match its content",
      });
    }
  }) satisfies z.ZodType<AgentInteractiveSessionStopCommand>;

export type AgentInteractiveSessionStopEffect =
  | "stop_requested"
  | "stopped"
  | "not_live"
  | "unknown";

export interface AgentInteractiveSessionStopAcknowledgement {
  operationId: string;
  requestDigest: `sha256:${string}`;
  ref: AgentInteractiveSessionRef;
  control: AgentInteractiveSessionControlClaim;
  status: "accepted" | "replayed" | "conflict" | "unknown";
  effect: AgentInteractiveSessionStopEffect;
  message?: string;
  retryable?: boolean;
  existingRequestDigest?: `sha256:${string}`;
}

export const AgentInteractiveSessionStopAcknowledgementSchema = z
  .strictObject({
    operationId: boundedIdentifierSchema,
    requestDigest: sha256DigestSchema,
    ref: AgentInteractiveSessionRefSchema,
    control: AgentInteractiveSessionControlClaimSchema,
    status: z.enum(["accepted", "replayed", "conflict", "unknown"]),
    effect: z.enum(["stop_requested", "stopped", "not_live", "unknown"]),
    message: boundedStringSchema.min(1).optional(),
    retryable: z.boolean().optional(),
    existingRequestDigest: sha256DigestSchema.optional(),
  })
  .superRefine((acknowledgement, refinement) => {
    if (
      !agentInteractiveSessionControlClaimMatchesRef(
        acknowledgement.ref,
        acknowledgement.control,
      )
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["control", "refDigest"],
        message: "interactive stop acknowledgement control does not match its process ref",
      });
    }
    const known = acknowledgement.effect !== "unknown";
    if (
      ((acknowledgement.status === "accepted" ||
        acknowledgement.status === "replayed") &&
        !known) ||
      ((acknowledgement.status === "conflict" ||
        acknowledgement.status === "unknown") &&
        known)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["effect"],
        message: "interactive stop status and effect certainty do not agree",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      (acknowledgement.existingRequestDigest === undefined ||
        acknowledgement.existingRequestDigest === acknowledgement.requestDigest)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "an interactive stop conflict must identify a different existing request",
      });
    }
    if (
      acknowledgement.status !== "conflict" &&
      acknowledgement.existingRequestDigest !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "only an interactive stop conflict may include an existing digest",
      });
    }
    if (
      acknowledgement.status === "unknown" &&
      (acknowledgement.message === undefined || acknowledgement.retryable !== true)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["retryable"],
        message:
          "an unknown interactive stop outcome must explicitly permit safe same-operation retry",
      });
    }
  }) satisfies z.ZodType<AgentInteractiveSessionStopAcknowledgement>;

export function agentInteractiveSessionStopAcknowledgementMatchesCommand(
  command: AgentInteractiveSessionStopCommand,
  acknowledgement: AgentInteractiveSessionStopAcknowledgement,
): boolean {
  const exactCommand = AgentInteractiveSessionStopCommandSchema.safeParse(command);
  const exactAcknowledgement =
    AgentInteractiveSessionStopAcknowledgementSchema.safeParse(acknowledgement);
  if (!exactCommand.success || !exactAcknowledgement.success) return false;
  return (
    exactAcknowledgement.data.operationId === exactCommand.data.operationId &&
    exactAcknowledgement.data.requestDigest === exactCommand.data.requestDigest &&
    canonicalCandidateDigest(exactAcknowledgement.data.ref) ===
      canonicalCandidateDigest(exactCommand.data.ref) &&
    canonicalCandidateDigest(exactAcknowledgement.data.control) ===
      canonicalCandidateDigest(exactCommand.data.control)
  );
}

/** Terminal returned after attach; every write remains bound to this claim. */
export interface AgentInteractiveTerminalSession extends AgentTerminalSession {
  readonly control: AgentInteractiveSessionControlClaim;
}

export interface AgentInteractiveSessionPromptCommandMaterial {
  operationId: string;
  ref: AgentInteractiveSessionRef;
  control: AgentInteractiveSessionControlClaim;
  prompt: string;
}

const AgentInteractiveSessionPromptCommandMaterialSchema = z
  .strictObject({
    operationId: boundedIdentifierSchema,
    ref: AgentInteractiveSessionRefSchema,
    control: AgentInteractiveSessionControlClaimSchema,
    prompt: boundedStringSchema.min(1),
  })
  .superRefine((command, refinement) => {
    if (!agentInteractiveSessionControlClaimMatchesRef(command.ref, command.control)) {
      refinement.addIssue({
        code: "custom",
        path: ["control", "refDigest"],
        message: "interactive prompt control claim does not match its process ref",
      });
    }
  });

export interface AgentInteractiveSessionPromptCommand
  extends AgentInteractiveSessionPromptCommandMaterial {
  requestDigest: `sha256:${string}`;
}

export function agentInteractiveSessionPromptRequestDigest(
  value: AgentInteractiveSessionPromptCommandMaterial,
): `sha256:${string}` {
  const parsed = AgentInteractiveSessionPromptCommandMaterialSchema.parse(value);
  return canonicalCandidateDigest({
    kind: "agent-interactive-session-prompt.v1",
    operationId: parsed.operationId,
    ref: parsed.ref,
    control: parsed.control,
    prompt: parsed.prompt,
  });
}

export const AgentInteractiveSessionPromptCommandSchema = z
  .strictObject({
    ...AgentInteractiveSessionPromptCommandMaterialSchema.shape,
    requestDigest: sha256DigestSchema,
  })
  .superRefine((command, refinement) => {
    const { requestDigest: _requestDigest, ...material } = command;
    if (command.requestDigest !== agentInteractiveSessionPromptRequestDigest(material)) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "interactive session prompt request digest does not match its content",
      });
    }
  }) satisfies z.ZodType<AgentInteractiveSessionPromptCommand>;

export interface AgentInteractiveSessionPromptAcknowledgement {
  operationId: string;
  requestDigest: `sha256:${string}`;
  ref: AgentInteractiveSessionRef;
  control: AgentInteractiveSessionControlClaim;
  status: "accepted" | "replayed" | "conflict" | "unknown";
  message?: string;
  retryable?: boolean;
  existingRequestDigest?: `sha256:${string}`;
}

export const AgentInteractiveSessionPromptAcknowledgementSchema = z
  .strictObject({
    operationId: boundedIdentifierSchema,
    requestDigest: sha256DigestSchema,
    ref: AgentInteractiveSessionRefSchema,
    control: AgentInteractiveSessionControlClaimSchema,
    status: z.enum(["accepted", "replayed", "conflict", "unknown"]),
    message: boundedStringSchema.min(1).optional(),
    retryable: z.boolean().optional(),
    existingRequestDigest: sha256DigestSchema.optional(),
  })
  .superRefine((acknowledgement, refinement) => {
    if (
      !agentInteractiveSessionControlClaimMatchesRef(
        acknowledgement.ref,
        acknowledgement.control,
      )
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["control", "refDigest"],
        message: "interactive prompt acknowledgement control claim does not match its process ref",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      (acknowledgement.existingRequestDigest === undefined ||
        acknowledgement.existingRequestDigest === acknowledgement.requestDigest)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "an interactive prompt conflict must identify a different existing request",
      });
    }
    if (
      acknowledgement.status !== "conflict" &&
      acknowledgement.existingRequestDigest !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "only an interactive prompt conflict may include an existing digest",
      });
    }
    if (
      acknowledgement.status === "unknown" &&
      (acknowledgement.message === undefined || acknowledgement.retryable !== true)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["retryable"],
        message:
          "an unknown interactive prompt outcome must explicitly permit safe same-operation retry",
      });
    }
  }) satisfies z.ZodType<AgentInteractiveSessionPromptAcknowledgement>;

export function agentInteractiveSessionPromptAcknowledgementMatchesCommand(
  command: AgentInteractiveSessionPromptCommand,
  acknowledgement: AgentInteractiveSessionPromptAcknowledgement,
): boolean {
  const exactCommand = AgentInteractiveSessionPromptCommandSchema.safeParse(command);
  const exactAcknowledgement =
    AgentInteractiveSessionPromptAcknowledgementSchema.safeParse(acknowledgement);
  if (!exactCommand.success || !exactAcknowledgement.success) return false;
  return (
    exactAcknowledgement.data.operationId === exactCommand.data.operationId &&
    exactAcknowledgement.data.requestDigest === exactCommand.data.requestDigest &&
    canonicalCandidateDigest(exactAcknowledgement.data.ref) ===
      canonicalCandidateDigest(exactCommand.data.ref) &&
    canonicalCandidateDigest(exactAcknowledgement.data.control) ===
      canonicalCandidateDigest(exactCommand.data.control)
  );
}

/**
 * Exact native TUI selected for one run.
 *
 * `attach` reaches the existing process. It never creates a shell or starts a
 * second coding-agent process. Detach and terminal close affect only the live
 * socket; `stop` terminates the provider-owned coding-agent process.
 */
export interface AgentInteractiveSession {
  readonly ref: AgentInteractiveSessionRef;
  /** Claim a newer provider generation after coordinator recovery. */
  claimControl(
    request: AgentInteractiveSessionControlClaimRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AgentInteractiveSessionControlClaimAcknowledgement>;
  status(options?: {
    signal?: AbortSignal;
  }): Promise<AgentInteractiveSessionStatus>;
  attach(
    request: AgentInteractiveSessionAttach,
    options?: { signal?: AbortSignal },
  ): Promise<AgentInteractiveTerminalSession>;
  sendPrompt?(
    /** The provider persists this operation before delivering the prompt. */
    command: AgentInteractiveSessionPromptCommand,
    options?: { signal?: AbortSignal },
  ): Promise<AgentInteractiveSessionPromptAcknowledgement>;
  stop(
    command: AgentInteractiveSessionStopCommand,
    options?: { signal?: AbortSignal },
  ): Promise<AgentInteractiveSessionStopAcknowledgement>;
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
    observed.preparationReceipt.digest ===
      parsedRef.data.preparationReceipt.digest &&
    observed.incarnationId === parsedRef.data.incarnationId &&
    observed.startedAt === parsedRef.data.startedAt &&
    sameExactRun(observed.run, parsedRef.data.run)
  );
}
