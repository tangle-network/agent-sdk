import { describe, expect, it } from "vitest";
import {
  InteractionKind,
  type RequestedInteractions,
} from "@tangle-network/agent-interface";
import {
  hasReplayPayload,
  sessionPromptRequestDigest,
} from "./tangle-environment-control.js";
import { promptOptionsFromTurnInput } from "./tangle-prompt.js";

const target = {
  provider: "tangle-sandbox",
  environmentId: "environment-1",
  sessionId: "session-1",
};

const requested: RequestedInteractions = {
  [InteractionKind.Permission]: true,
  [InteractionKind.Question]: false,
  [InteractionKind.Plan]: true,
};

describe("Tangle per-turn requested interactions", () => {
  it("writes the exact shared posture to Sandbox backend options", () => {
    const options = promptOptionsFromTurnInput(
      {
        prompt: "continue",
        sessionId: target.sessionId,
        model: "model-1",
        timeoutMs: 1_000,
        interactions: requested,
      },
      target,
    );

    expect(options).toMatchObject({
      sessionId: target.sessionId,
      model: "model-1",
      timeoutMs: 1_000,
      backend: { interactions: requested },
    });
    expect(options.backend).toEqual({ interactions: requested });
    expect(options).not.toHaveProperty("providerOptions");
  });

  it("keeps an omitted posture omitted on the Sandbox wire", () => {
    const options = promptOptionsFromTurnInput(
      { prompt: "continue", sessionId: target.sessionId },
      target,
    );

    expect(options.backend).toBeUndefined();
  });

  it("binds an explicit posture into retained replay identity", () => {
    const input = {
      prompt: "continue",
      turnId: "turn-1",
      interactions: requested,
    };
    const withoutInteractions = {
      prompt: input.prompt,
      turnId: input.turnId,
    };

    expect(hasReplayPayload(input)).toBe(true);
    expect(
      sessionPromptRequestDigest(
        input,
        target.provider,
        target.environmentId,
        target.sessionId,
      ),
    ).not.toBe(
      sessionPromptRequestDigest(
        withoutInteractions,
        target.provider,
        target.environmentId,
        target.sessionId,
      ),
    );
  });
});
