import { describe, expect, it } from "vitest";
import type { PromptOptions } from "@tangle-network/sandbox";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";
import { sessionPromptRequestDigest } from "./tangle-environment-control.js";
import { promptOptionsFromTurnInput } from "./tangle-prompt.js";

const target = {
  provider: "tangle-sandbox",
  environmentId: "sbx-1",
};

/**
 * The per-turn backend block agent-runtime emits for a subscription seat: the
 * seat's credential files travel with the turn, so the box needs no long-lived
 * secret of its own.
 */
const SEAT_BACKEND = {
  type: "opencode",
  model: {
    provider: "zai",
    model: "glm-5.2",
    authMode: "oauth",
    authFiles: [
      {
        path: ".config/opencode/auth.json",
        content: '{"zai":{"type":"oauth","access":"seat-token"}}',
        mode: 0o600,
      },
    ],
  },
} as const;

function recordingBox(recorded: PromptOptions[]): SandboxInstanceLike {
  return {
    id: "sbx-1",
    status: "running",
    async waitFor() {},
    async *streamPrompt(_message, options) {
      if (options) recorded.push(options);
    },
  };
}

describe("Tangle per-turn backend options", () => {
  it("carries a session credential bundle to the Sandbox prompt call", async () => {
    const recorded: PromptOptions[] = [];
    const provider = createTangleProvider({
      client: {
        async create() {
          return recordingBox(recorded);
        },
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    for await (const _event of environment.stream({
      prompt: "run the task",
      sessionId: "session-1",
      providerOptions: { backend: SEAT_BACKEND },
    })) {
      // The turn's events are not the subject; the request that carried it is.
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.backend).toEqual(SEAT_BACKEND);
  });

  it("refuses a provider option the Sandbox prompt does not declare", () => {
    expect(() =>
      promptOptionsFromTurnInput(
        { prompt: "run", providerOptions: { arbitrary: true } },
        target,
      ),
    ).toThrow(/providerOptions are not supported: arbitrary/);
  });

  it("refuses a backend field the Sandbox prompt does not declare", () => {
    expect(() =>
      promptOptionsFromTurnInput(
        { prompt: "run", providerOptions: { backend: { sudo: true } } },
        target,
      ),
    ).toThrow(/backend options are not supported: sudo/);
  });

  it("refuses a backend model field the Sandbox prompt does not declare", () => {
    expect(() =>
      promptOptionsFromTurnInput(
        {
          prompt: "run",
          providerOptions: { backend: { model: { secretEnv: "TOKEN" } } },
        },
        target,
      ),
    ).toThrow(/backend model options are not supported: secretEnv/);
  });

  it("refuses an auth file that names no path or content", () => {
    for (const authFiles of [
      [{ content: "{}" }],
      [{ path: ".config/auth.json" }],
      [{ path: ".config/auth.json", content: "{}", owner: "root" }],
    ]) {
      expect(() =>
        promptOptionsFromTurnInput(
          {
            prompt: "run",
            providerOptions: { backend: { model: { authFiles } } },
          },
          target,
        ),
      ).toThrow(/auth file/);
    }
  });

  it("keeps an omitted backend field omitted on the Sandbox wire", () => {
    const options = promptOptionsFromTurnInput(
      {
        prompt: "run",
        providerOptions: { backend: { type: "opencode", model: { model: "glm-5.2" } } },
      },
      target,
    );

    expect(options.backend).toEqual({
      type: "opencode",
      model: { model: "glm-5.2" },
    });
  });

  it("refuses a provider option written as an explicit undefined", () => {
    // AgentTurnInput owns the JSON shape of providerOptions, and absence on the
    // wire is absence, never a key holding `undefined`. The adapter states no
    // second, softer rule over it.
    expect(() =>
      promptOptionsFromTurnInput(
        {
          prompt: "run",
          providerOptions: { backend: { model: { model: "glm-5.2", apiKey: undefined } } },
        },
        target,
      ),
    ).toThrow(/providerOptions/);
  });

  it("keeps the requested interaction posture beside the backend options", () => {
    const interactions = { question: true } as const;
    const options = promptOptionsFromTurnInput(
      {
        prompt: "run",
        interactions,
        providerOptions: {
          backend: { type: "codex", interactions: { question: true } },
        },
      },
      target,
    );

    expect(options.backend).toEqual({ type: "codex", interactions });
  });

  it("refuses an interaction posture that contradicts its backend options", () => {
    expect(() =>
      promptOptionsFromTurnInput(
        {
          prompt: "run",
          interactions: { question: true },
          providerOptions: { backend: { interactions: { permission: true } } },
        },
        target,
      ),
    ).toThrow(/interactions conflict with its backend interactions/);
  });

  it("refuses a turn model that contradicts its backend model", () => {
    expect(() =>
      promptOptionsFromTurnInput(
        {
          prompt: "run",
          model: "glm-5.2",
          providerOptions: { backend: { model: { model: "gpt-5-mini" } } },
        },
        target,
      ),
    ).toThrow(/model conflicts with its backend model/);
  });

  it("binds backend options into the retained request identity", () => {
    const digestFor = (backend: unknown): string =>
      sessionPromptRequestDigest(
        { prompt: "run", turnId: "turn-1", providerOptions: { backend } },
        target.provider,
        target.environmentId,
        "session-1",
      );

    // A retry that changes the seat, the model, or the credentials is different
    // work, so it must not replay the recorded result of the earlier turn.
    expect(digestFor(SEAT_BACKEND)).not.toBe(
      digestFor({ ...SEAT_BACKEND, model: { ...SEAT_BACKEND.model, model: "glm-5.3" } }),
    );
    expect(digestFor(SEAT_BACKEND)).toBe(digestFor(SEAT_BACKEND));
    expect(
      sessionPromptRequestDigest(
        { prompt: "run", turnId: "turn-1" },
        target.provider,
        target.environmentId,
        "session-1",
      ),
    ).not.toBe(digestFor(SEAT_BACKEND));
  });
});
