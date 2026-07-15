import { describe, expect, it } from "vitest";
import {
  AgentExecutionOutcomeSchema,
  PlanContinuationSchema,
  PlanSubmissionSchema,
} from "./plan.js";

const codexState = {
  kind: "codex" as const,
  version: 1 as const,
  threadId: "thread-1",
};

const plan = {
  id: "plan-1",
  revision: 1,
  body: "Implement the approved design",
  submittedAt: "2026-07-10T00:00:00.000Z",
};

describe("durable plan contract", () => {
  it("requires a full non-empty body and a closed provider state", () => {
    expect(
      PlanSubmissionSchema.safeParse({
        body: " ",
        sourceToolCallId: "tool-1",
        providerState: codexState,
      }).success,
    ).toBe(false);
    expect(
      PlanSubmissionSchema.safeParse({
        body: "Plan",
        sourceToolCallId: "tool-1",
        providerState: { kind: "factory-droids", version: 1 },
      }).success,
    ).toBe(false);
  });

  it("requires feedback when a rejected plan starts its revision turn", () => {
    expect(
      PlanContinuationSchema.safeParse({
        version: 1,
        plan,
        sourceToolCallId: "tool-1",
        decision: { outcome: "rejected", feedback: " " },
        providerState: codexState,
      }).success,
    ).toBe(false);
  });

  it("accepts a typed provider continuation and terminal outcome", () => {
    expect(
      PlanContinuationSchema.parse({
        version: 1,
        plan,
        sourceToolCallId: "tool-1",
        decision: { outcome: "approved" },
        providerState: codexState,
      }),
    ).toMatchObject({ decision: { outcome: "approved" } });
    expect(
      AgentExecutionOutcomeSchema.parse({
        type: "awaiting_plan_decision",
        plan,
      }),
    ).toMatchObject({ type: "awaiting_plan_decision", plan: { id: "plan-1" } });
  });
});
