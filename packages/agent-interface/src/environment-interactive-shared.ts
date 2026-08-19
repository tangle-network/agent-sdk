import { z } from "zod";
import type { AgentExactRunControlRef } from "./runtime-control.js";

const INTERACTIVE_MAX_DIMENSION = 10_000;

export const agentInteractiveDimensionSchema = z
  .number()
  .int()
  .positive()
  .max(INTERACTIVE_MAX_DIMENSION);

/** @internal Compare every coordinate of two exact run references. */
export function sameAgentExactRun(
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
