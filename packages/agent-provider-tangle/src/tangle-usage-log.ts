import type { TokenUsage } from "@tangle-network/agent-interface";
import { boundedIdentifier } from "./tangle-contract-safety.js";

/** One execution's measured token usage and cost. */
export interface ExecutionUsageRecord {
  executionId: string;
  usage: TokenUsage;
  observedAt: string;
}

/**
 * The newest per-execution usage this environment handle measured.
 *
 * Sandbox reports token usage and cost on the result of one execution, never
 * for the environment as a whole, so the only environment-scoped answer is the
 * newest execution the handle actually saw. The record lives with the handle:
 * an environment rebuilt through `provider.get(id)` starts with none, and the
 * observation then reports the usage surface as unavailable rather than as a
 * measured zero.
 */
export interface ExecutionUsageLog {
  record(executionId: string | undefined, usage: TokenUsage | undefined): void;
  latest(): ExecutionUsageRecord | undefined;
}

export function createExecutionUsageLog(): ExecutionUsageLog {
  let latest: ExecutionUsageRecord | undefined;
  return {
    record(executionId, usage) {
      // Usage without the execution it belongs to cannot be attributed, and an
      // execution without usage measured nothing. Neither is recorded.
      if (executionId === undefined || usage === undefined) return;
      latest = {
        executionId: boundedIdentifier(executionId, "Tangle execution id"),
        usage,
        observedAt: new Date().toISOString(),
      };
    },
    latest() {
      return latest === undefined
        ? undefined
        : { ...latest, usage: { ...latest.usage } };
    },
  };
}
