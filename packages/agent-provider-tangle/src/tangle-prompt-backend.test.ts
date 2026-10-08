import { describe, expect, it } from "vitest";
import type { PromptOptions } from "@tangle-network/sandbox";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";
import { hasReplayPayload, sessionPromptRequestDigest } from "./tangle-environment-control.js";
import {
  backendRequestIdentity,
  promptOptionsFromTurnInput,
} from "./tangle-prompt.js";

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

  it("refuses new flat routing and secret fields before dispatch", () => {
    for (const backend of [
      { modelId: "gpt-6-sol" },
      { cliAuth: { account: "other-seat", secretEnv: "OTHER_SEAT", format: "bundle" } },
      { runtimeSecrets: { TOKEN: "private-fixture" } },
    ]) {
      expect(() =>
        promptOptionsFromTurnInput(
          { prompt: "run", providerOptions: { backend } },
          target,
        ),
      ).toThrow(/backend options are not supported:/);
    }
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

  it("refuses a backend model value of the wrong type", () => {
    for (const model of [
      { model: 123 },
      { maxThinkingTokens: 1.5 },
      { mode: "shell" },
      { authMode: "device-code" },
    ]) {
      expect(() =>
        promptOptionsFromTurnInput(
          { prompt: "run", providerOptions: { backend: { model } } },
          target,
        ),
      ).toThrow(/Tangle prompt backend model/);
    }
  });

  it("reads an inline profile with the schema that owns profile rules", () => {
    expect(() =>
      promptOptionsFromTurnInput(
        {
          prompt: "run",
          providerOptions: { backend: { profile: { name: "worker", tools: "all" } } },
        },
        target,
      ),
    ).toThrow();

    expect(
      promptOptionsFromTurnInput(
        {
          prompt: "run",
          providerOptions: { backend: { profile: { name: "worker" } } },
        },
        target,
      ).backend?.profile,
    ).toMatchObject({ name: "worker" });
  });

  it("holds trace attributes to the limits the Sandbox platform states", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"]),
    );
    expect(() =>
      promptOptionsFromTurnInput(
        {
          prompt: "run",
          providerOptions: { backend: { metadata: { traceAttributes: tooMany } } },
        },
        target,
      ),
    ).toThrow(/traceAttributes exceeds 32 entries/);
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

  it("keeps the retained identity stable across a seat token refresh", () => {
    const digestFor = (backend: unknown): string =>
      sessionPromptRequestDigest(
        { prompt: "run", turnId: "turn-1", providerOptions: { backend } },
        target.provider,
        target.environmentId,
        "session-1",
      );
    const rotated = {
      ...SEAT_BACKEND,
      model: {
        ...SEAT_BACKEND.model,
        apiKey: "rotated-key",
        authFiles: [
          {
            ...SEAT_BACKEND.model.authFiles[0],
            content: '{"zai":{"type":"oauth","access":"rotated-token"}}',
          },
        ],
      },
    };

    // A rotated token is the same seat running the same work. Binding the
    // identity to the token bytes would make an ordinary refresh conflict with
    // the run it continues.
    expect(digestFor(rotated)).toBe(digestFor(SEAT_BACKEND));
    // The slot the bundle fills is still part of the identity.
    expect(
      digestFor({
        ...SEAT_BACKEND,
        model: {
          ...SEAT_BACKEND.model,
          authFiles: [{ ...SEAT_BACKEND.model.authFiles[0], path: ".config/other.json" }],
        },
      }),
    ).not.toBe(digestFor(SEAT_BACKEND));
  });

  it("keeps bearer material out of the retained identity", () => {
    const identity = backendRequestIdentity(
      promptOptionsFromTurnInput(
        { prompt: "run", providerOptions: { backend: SEAT_BACKEND } },
        target,
      ).backend,
    );

    expect(JSON.stringify(identity)).not.toContain("seat-token");
    expect(identity?.model).toMatchObject({
      provider: "zai",
      model: "glm-5.2",
      authMode: "oauth",
      authFiles: [{ path: ".config/opencode/auth.json", mode: 0o600 }],
    });
  });
});


describe("typed exact turn profile projection", () => {
  const profile = { name: "worker", harness: "claude-code" as const, tools: { Read: true } };

  it("accepts a matching legacy declaration without changing the exact profile", () => {
    const options = promptOptionsFromTurnInput({
      prompt: "run", profile,
      providerOptions: { backend: { type: "claude-code", profile: { tools: { Read: true }, harness: "claude-code", name: "worker" } } },
    }, target);
    expect(options.backend?.profile).toEqual(profile);
  });

  it("refuses contradictory profile and harness declarations", () => {
    expect(() => promptOptionsFromTurnInput({
      prompt: "run", profile,
      providerOptions: { backend: { profile: { ...profile, tools: { Bash: true } } } },
    }, target)).toThrow(/profile conflicts with its backend profile/);
    expect(() => promptOptionsFromTurnInput({
      prompt: "run", profile,
      providerOptions: { backend: { type: "codex" } },
    }, target)).toThrow(/profile conflicts with its backend harness/);
  });

  it("binds the typed profile into retained identity and explicit replay payload", () => {
    const typed = { prompt: "run", turnId: "same-turn", profile };
    const legacy = { prompt: "run", turnId: "same-turn", providerOptions: { backend: { profile } } };
    const digest = (input: Parameters<typeof sessionPromptRequestDigest>[0]) => sessionPromptRequestDigest(input, target.provider, target.environmentId, "session-1");
    expect(digest(typed)).toBe(digest(legacy));
    expect(digest(typed)).not.toBe(digest({ ...typed, profile: { ...profile, tools: { Bash: true } } }));
    expect(hasReplayPayload({ profile })).toBe(true);
  });

  it("retains profile-aware payload limits and bounded profile metadata", () => {
    for (const resources of [
      { files: [{ path: "too-large.txt", resource: { kind: "inline" as const, name: "large", content: "x".repeat(4 * 1024 * 1024 + 1) } }] },
      { instructions: "x".repeat(1024 * 1024) },
    ]) {
      expect(() => promptOptionsFromTurnInput({ prompt: "run", profile: { ...profile, resources } }, target)).toThrow(/bound/);
    }
    expect(() => promptOptionsFromTurnInput({
      prompt: "run", profile: { ...profile, metadata: { long: "x".repeat(16385) } },
    }, target)).toThrow(/bound/);
  });
});
