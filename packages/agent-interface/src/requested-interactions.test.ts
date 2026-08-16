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

const customRequested: RequestedInteractions = {
  "review.patch": true,
  "pi.extension.deploy": false,
};

const executionInput: AgentExecutionInput = {
  systemPrompt: "system",
  interactions: requested,
};
void executionInput;

const omittedInteraction: RequestedInteractions["permission"] = undefined;
void omittedInteraction;

describe("requested interactions", () => {
  it("accepts an empty posture, well-known kinds, and namespaced provider kinds", () => {
    expect(RequestedInteractionsSchema.parse({})).toEqual({});
    expect(RequestedInteractionsSchema.parse(requested)).toEqual(requested);
    expect(RequestedInteractionsSchema.parse(customRequested)).toEqual(
      customRequested,
    );
  });

  it("keeps an omitted interaction kind absent at runtime", () => {
    const posture = RequestedInteractionsSchema.parse({});

    expect(posture.permission).toBeUndefined();
  });

  it("rejects invalid identifiers and wrongly typed interaction keys", () => {
    expect(
      RequestedInteractionsSchema.safeParse({ " approval ": true }).success,
    ).toBe(false);
    expect(RequestedInteractionsSchema.safeParse({ approval: true }).success).toBe(
      false,
    );
    expect(
      RequestedInteractionsSchema.safeParse({
        [InteractionKind.Question]: "enabled",
      }).success,
    ).toBe(false);
  });

  it("bounds the number of provider interaction kinds", () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`custom.${index}`, true]),
    );
    expect(RequestedInteractionsSchema.safeParse(oversized).success).toBe(false);
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
