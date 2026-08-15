import { describe, expect, it } from "vitest";
import {
  AgentTurnInputSchema,
  InteractionKind,
  RequestedInteractionsSchema,
  type AgentExecutionInput,
  type RequestedInteractions,
} from "./index.js";

const requested: RequestedInteractions = {
  [InteractionKind.Permission]: true,
  [InteractionKind.Question]: false,
  [InteractionKind.Plan]: true,
};

const executionInput: AgentExecutionInput = {
  systemPrompt: "system",
  interactions: requested,
};
void executionInput;

describe("requested interactions", () => {
  it("accepts an empty posture and the existing well-known interaction kinds", () => {
    expect(RequestedInteractionsSchema.parse({})).toEqual({});
    expect(RequestedInteractionsSchema.parse(requested)).toEqual(requested);
  });

  it("rejects unknown and wrongly typed interaction keys", () => {
    expect(
      RequestedInteractionsSchema.safeParse({ approval: true }).success,
    ).toBe(false);
    expect(
      RequestedInteractionsSchema.safeParse({
        [InteractionKind.Question]: "enabled",
      }).success,
    ).toBe(false);
  });

  it("validates the posture when it is carried by an agent turn", () => {
    expect(
      AgentTurnInputSchema.parse({ prompt: "continue", interactions: requested }),
    ).toMatchObject({ interactions: requested });
    expect(() =>
      AgentTurnInputSchema.parse({
        prompt: "continue",
        interactions: { [InteractionKind.Permission]: 1 },
      }),
    ).toThrow();
  });
});
