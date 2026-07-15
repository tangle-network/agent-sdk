import { z } from "zod";

/** Harnesses with an enforceable durable-plan continuation contract. */
export const PlanProviderKindSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
]);
export type PlanProviderKind = z.infer<typeof PlanProviderKindSchema>;

/**
 * Credential-free provider correlation committed with the plan. This union is
 * deliberately closed: adding plan support for another harness requires an
 * explicit resume contract instead of smuggling opaque metadata through.
 */
export const PlanProviderStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claude-code"),
    version: z.literal(1),
    nativeSessionId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("codex"),
    version: z.literal(1),
    threadId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("opencode"),
    version: z.literal(1),
  }).strict(),
]);
export type PlanProviderState = z.infer<typeof PlanProviderStateSchema>;

/**
 * A plan committed by the runtime before the planning turn is allowed to end.
 * The full body is part of the contract so consumers never reconstruct it from
 * rendered chat text.
 */
export const DurablePlanSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1),
  submittedAt: z.string().datetime({ offset: true }),
}).strict();
export type DurablePlan = z.infer<typeof DurablePlanSchema>;

/** Provider-originated data required to commit a plan exactly once. */
export const PlanSubmissionSchema = z.object({
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1),
  /** Stable provider tool-call identity reused when a lost acknowledgement retries. */
  sourceToolCallId: z.string().min(1),
  /** Credential-free correlation required to resume the deferred turn. */
  providerState: PlanProviderStateSchema,
}).strict();
export type PlanSubmission = z.infer<typeof PlanSubmissionSchema>;

/** The human verdict that starts the next turn. */
export const PlanDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("approved") }).strict(),
  z.object({
    outcome: z.literal("rejected"),
    feedback: z.string().trim().min(1),
  }).strict(),
]);
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;

/**
 * Typed server-originated continuation. Adapters consume this instead of
 * inferring approval from a free-form user message.
 */
export const PlanContinuationSchema = z.object({
  version: z.literal(1),
  plan: DurablePlanSchema,
  sourceToolCallId: z.string().min(1),
  decision: PlanDecisionSchema,
  /** Exact payload previously committed with the plan submission. */
  providerState: PlanProviderStateSchema,
}).strict();
export type PlanContinuation = z.infer<typeof PlanContinuationSchema>;

/** Terminal meaning of a successfully completed adapter invocation. */
export const AgentExecutionOutcomeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("completed") }).strict(),
  z.object({
    type: z.literal("awaiting_plan_decision"),
    plan: DurablePlanSchema,
  }).strict(),
]);
export type AgentExecutionOutcome = z.infer<
  typeof AgentExecutionOutcomeSchema
>;

/**
 * Per-turn host command used by providers to commit a plan. Implementations
 * bind project, host-session, and turn identity outside provider-controlled
 * input and must resolve only after the durable write commits.
 */
export interface SdkPlanHost {
  submit(submission: PlanSubmission): Promise<DurablePlan>;
  /** Publish a committed plan only after the provider turn has terminalized. */
  confirm(planId: string): Promise<void>;
  /** Compensate a committed plan when provider terminalization cannot be proven. */
  withdraw(planId: string, reason: string): Promise<void>;
}
