import { z } from "zod";
import { deepFreeze } from "./deep-freeze.js";
import { TokenUsageSchema } from "./execution-types.js";

export const AgentExecutionFailureReceiptSchema = z.strictObject({
  tokenUsage: TokenUsageSchema.partial().optional(),
  timing: z.strictObject({
    startedAt: z.number().finite().nonnegative(),
    completedAt: z.number().finite().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
  }).optional(),
});

/** Observed accounting only; a failed execution may have additional unreported usage. */
export type AgentExecutionFailureReceipt = z.infer<typeof AgentExecutionFailureReceiptSchema>;

/** Retains observed resource use while preserving the adapter's rejection contract. */
export class AgentExecutionError extends Error {
  readonly receipt: AgentExecutionFailureReceipt;

  constructor(message: string, receipt: AgentExecutionFailureReceipt, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentExecutionError";
    this.receipt = deepFreeze(AgentExecutionFailureReceiptSchema.parse(receipt));
  }
}
