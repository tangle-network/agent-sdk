import { Sandbox, type CreateSandboxOptions } from "@tangle-network/sandbox";
import type { CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it, vi } from "vitest";
import { createTangleProvider, type TangleModelCredentials } from "./index.js";
import { promptOptionsFromTurnInput } from "./tangle-prompt.js";

const native: TangleModelCredentials = {
  cliAuth: { account: "claude-research", secretEnv: "CLAUDE_RESEARCH", format: "token" },
};
const api: TangleModelCredentials = { apiKeyEnv: "GLM_PLAN", baseUrl: "https://plan.example/v1" };
const profile = {
  name: "research-director", harness: "claude-code" as const,
  model: { provider: "anthropic", default: "fixture-model" },
};
function setup() {
  const creates: CreateSandboxOptions[] = [];
  return {
    creates,
    client: {
      async create(options?: CreateSandboxOptions) {
        creates.push(options ?? {});
        return { id: `subscription-${creates.length}`, status: "running", metadata: options?.metadata, capabilities: async () => ({ cliAuthReferences: true }), async *streamPrompt() {} };
      },
    },
  };
}

describe("Tangle per-profile subscription creation", () => {
  it("selects once for an idempotent root and independently for each exact child profile", async () => {
    const { creates, client } = setup();
    const selected: Readonly<CreateAgentEnvironmentInput>[] = [];
    const resolver = vi.fn(async (input: Readonly<CreateAgentEnvironmentInput>): Promise<TangleModelCredentials> => {
      selected.push(input);
      const harness = typeof input.profile === "string" ? undefined : input.profile.harness;
      if (harness === "claude-code") return native;
      if (harness === "codex") return { cliAuth: { account: "codex-research", secretEnv: "CODEX_RESEARCH", format: "bundle" } };
      if (harness === "kimi-code") return { cliAuth: { account: "kimi-research", secretEnv: "KIMI_RESEARCH", format: "files" } };
      return api;
    });
    const provider = createTangleProvider({ client, modelCredentials: resolver });
    const root = { profile, idempotencyKey: "runtime:root", secrets: ["COORDINATION_TOKEN"], metadata: { run: "root" } };
    const rootEnvironment = await provider.create(root);
    await provider.create(root);
    const children = [
      { ...profile, name: "claude-child" },
      { name: "codex-child", harness: "codex" as const, model: { provider: "openai", default: "fixture-codex" } },
      { name: "kimi-child", harness: "kimi-code" as const, model: { provider: "moonshot", default: "fixture-kimi" } },
      { name: "glm-child", harness: "opencode" as const, model: { provider: "zai", default: "fixture-glm" } },
    ];
    for (const child of children) await provider.create({ profile: child, idempotencyKey: `runtime:${child.name}` });
    expect(resolver).toHaveBeenCalledTimes(5);
    expect(creates.map((create) => create.backend?.profile)).toEqual([profile, ...children]);
    expect(creates.map((create) => create.backend?.type)).toEqual(["claude-code", "claude-code", "codex", "kimi-code", "opencode"]);
    expect(creates.map((create) => create.secrets)).toEqual([
      ["COORDINATION_TOKEN", "CLAUDE_RESEARCH"], ["CLAUDE_RESEARCH"], ["CODEX_RESEARCH"], ["KIMI_RESEARCH"], ["GLM_PLAN"],
    ]);
    expect(rootEnvironment.metadata).toEqual({ run: "root", modelCredentials: native });
    expect(root).toEqual({ profile, idempotencyKey: "runtime:root", secrets: ["COORDINATION_TOKEN"], metadata: { run: "root" } });
    expect(Object.isFrozen(selected[0]?.profile)).toBe(true);
    expect(Object.isFrozen(selected[0]?.secrets)).toBe(true);
  });

  it("snapshots resolver output and preserves cancellation identity", async () => {
    const { creates, client } = setup();
    const controller = new AbortController();
    const mutable = { cliAuth: { account: "original", secretEnv: "ORIGINAL", format: "token" as const } };
    const provider = createTangleProvider({ client, modelCredentials: async (input) => {
      expect(input.signal).toBe(controller.signal);
      return mutable;
    } });
    await provider.create({ profile, signal: controller.signal });
    mutable.cliAuth.account = "changed";
    expect(creates[0]?.backend?.model).toEqual({ cliAuth: { account: "original", secretEnv: "ORIGINAL", format: "token" }, authMode: "oauth" });
    expect(creates[0]?.metadata).toEqual({ modelCredentials: { cliAuth: { account: "original", secretEnv: "ORIGINAL", format: "token" } } });
  });

  it.each([
    undefined,
    { cliAuth: { account: "research", secretEnv: "TOKEN", format: "unsupported" } },
    { cliAuth: { account: "research", secretEnv: "TOKEN", format: "token" }, apiKey: "private-fixture" },
    { apiKeyEnv: "GLM_PLAN", baseUrl: "https://plan.example/v1", model: "replacement-model" },
  ])("refuses an invalid selection before any box or Router path (%j)", async (value) => {
    const { creates, client } = setup();
    const provider = createTangleProvider({ client, modelCredentials: async () => value as never });
    await expect(provider.create({ profile })).rejects.toThrow();
    expect(creates).toEqual([]);
  });

  it("propagates a held or exhausted account refusal with zero provisioning", async () => {
    const { creates, client } = setup();
    const error = new Error("No eligible registered account");
    const provider = createTangleProvider({ client, modelCredentials: async () => { throw error; } });
    await expect(provider.create({ profile })).rejects.toBe(error);
    expect(creates).toEqual([]);
  });

  it("refuses a native channel the exact profile harness cannot honor", async () => {
    const { creates, client } = setup();
    const provider = createTangleProvider({ client, modelCredentials: async () => native });
    await expect(provider.create({ profile: { name: "codex", harness: "codex" } })).rejects.toThrow(/tokens are unsupported/);
    await expect(provider.create({ profile, backend: "codex" })).rejects.toThrow(/exact profile harness/);
    expect(creates).toEqual([]);
  });

  it("refuses a dynamic API selection whose backend overrides the exact profile harness", async () => {
    const { creates, client } = setup();
    const provider = createTangleProvider({ client, defaultBackend: "codex", modelCredentials: async () => api });
    await expect(provider.create({ profile: { name: "glm", harness: "opencode", model: { provider: "zai", default: "fixture-glm" } } }))
      .rejects.toThrow(/exact profile harness/);
    expect(creates).toEqual([]);
  });

  it("refuses inline shadowing and forged public selection metadata", async () => {
    const { creates, client } = setup();
    const provider = createTangleProvider({ client, modelCredentials: async () => native });
    await expect(provider.create({ profile, env: { CLAUDE_RESEARCH: "private-fixture" } })).rejects.toThrow(/shadow/);
    await expect(provider.create({ profile, metadata: { modelCredentials: { account: "forged" } } })).rejects.toThrow(/owns metadata/);
    expect(creates).toEqual([]);
  });

  it("cancels a pending selector without creating an environment", async () => {
    const { creates, client } = setup();
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const provider = createTangleProvider({ client, modelCredentials: () => {
      markStarted();
      return new Promise(() => {});
    } });
    const pending = provider.create({ profile, signal: controller.signal });
    await started;
    controller.abort(new Error("cancelled-fixture"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(creates).toEqual([]);
  });

  it("validates the default projection before invoking an external selector", async () => {
    const { creates, client } = setup();
    const resolver = vi.fn(async () => native);
    const provider = createTangleProvider({ client, modelCredentials: resolver });
    await expect(provider.create({ profile, providerOptions: { unknown: true } })).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
    expect(creates).toEqual([]);
  });

  it("rejects a custom mapper combined with a selector", () => {
    expect(() => createTangleProvider({ client: setup().client, modelCredentials: async () => native, mapCreateInput: () => ({}) }))
      .toThrow(/cannot be combined/);
  });

  it("refuses an unqualified selected host before dispatch and deletes only a newly created box", async () => {
    const deleted = vi.fn(async () => {});
    let turns = 0;
    const provider = createTangleProvider({
      modelCredentials: async () => native,
      client: { async create() { return {
        id: "old-runtime", status: "running", metadata: { modelCredentials: native },
        capabilities: async () => ({ cliAuthReferences: false }),
        createReceipt: () => ({ outcome: "created" as const, idempotencyKeyApplied: true }), delete: deleted,
        async *streamPrompt() { turns++; },
      }; } },
    });
    await expect(provider.create({ profile })).rejects.toThrow(/does not prove native credential reference support/);
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(turns).toBe(0);
  });

  it("checks native mapped credential grants and mixed authentication before provisioning", async () => {
    const { creates, client } = setup();
    const noGrant = createTangleProvider({ client, mapCreateInput: () => ({ backend: { type: "claude-code", profile, model: native } }) });
    await expect(noGrant.create({ profile })).rejects.toThrow(/explicitly listed/);
    const mixed = createTangleProvider({ client, mapCreateInput: () => ({ secrets: ["CLAUDE_RESEARCH"], backend: { type: "claude-code", profile, model: { ...native, apiKeyEnv: "API_KEY" } } }) });
    await expect(mixed.create({ profile })).rejects.toThrow(/cannot be combined/);
    expect(creates).toEqual([]);
  });

  it("preserves the chosen native reference through the maintained SDK HTTP create, turn, and recovered handle", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    let metadata: Record<string, unknown> | undefined;
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      requests.push({ url, body });
      if (url.endsWith("/v1/backends")) return json({
        backends: [{
          type: "claude-code", name: "Claude Code", description: "fixture",
          capabilities: {
            streaming: true, toolUse: true, reasoning: true, multimodal: false,
            imageInput: false, contextWindow: 128_000, mcp: true, sessions: true,
            configurable: true, interactions: [], runtimeAttachments: { mcp: true },
          },
        }], timestamp: new Date(0).toISOString(),
      });
      if (url.endsWith("/v1/sandboxes") || url.endsWith("/v1/sandboxes/native-box")) {
        if (url.endsWith("/v1/sandboxes")) metadata = body.metadata;
        return json({
          id: "native-box", status: "running", createdAt: new Date(0).toISOString(), metadata,
          filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
          filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
          connection: { runtimeUrl: "https://sandbox.example/runtime", authToken: "fixture-runtime-token", edgeStatus: "ready" },
        });
      }
      if (url.endsWith("/capabilities")) return json({
        schema: 1, cliAuthReferences: true, agentInterface: "2.15.0", sidecarVersion: "fixture", image: "fixture",
        dispatch: { runControlRef: false, executionIdOnAdmission: false },
        cancel: { canonicalRunCancellation: false, digestBound: false, idempotent: false },
        runs: { executionScopedStatus: false, eventReplay: false }, interactions: {},
      });
      if (url.endsWith("/agents/backend/status")) return json({ type: "claude-code" });
      if (url.endsWith("/agents/run/stream")) return new Response('id: event-1\nevent: done\ndata: {"status":"completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
      throw new Error(`Unexpected SDK request: ${url}`);
    });
    try {
      const provider = createTangleProvider({
        client: new Sandbox({ baseUrl: "https://sandbox.example", apiKey: "fixture-api-key" }),
        modelCredentials: async () => native,
      });
      const environment = await provider.create({ profile, idempotencyKey: "runtime:root" });
      for await (const _event of environment.stream({ prompt: "research" })) {}
      const create = requests.find((request) => request.url.endsWith("/v1/sandboxes"));
      const turn = requests.find((request) => request.url.endsWith("/agents/run/stream"));
      expect(create?.body.backend).toEqual({ type: "claude-code", profile, model: { ...native, authMode: "oauth" } });
      expect(create?.body.secrets).toEqual(["CLAUDE_RESEARCH"]);
      expect(create?.body.metadata).toEqual({ modelCredentials: native });
      expect(turn?.body.backend).toEqual(create?.body.backend);
      const recovered = await provider.get?.(environment.id);
      expect(recovered?.metadata).toEqual({ modelCredentials: native });
      if (!recovered) throw new Error("Expected native environment recovery");
      for await (const _event of recovered.stream({ prompt: "continue research" })) {}
      const turns = requests.filter((request) => request.url.endsWith("/agents/run/stream"));
      expect(turns).toHaveLength(2);
      // The recovered SDK leaves omitted configuration to the persisted native backend.
      expect(turns[1]?.body.backend).toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });

  it("refuses a native record recovered on an older selected runtime", async () => {
    const turns = vi.fn();
    const provider = createTangleProvider({ client: {
      async create() { throw new Error("Unexpected create"); },
      async get() { return { id: "native-recovered", status: "running", metadata: { modelCredentials: native }, capabilities: async () => ({ schema: 1 }), async *streamPrompt() { turns(); } }; },
    } });
    await expect(provider.get?.("native-recovered")).rejects.toThrow(/does not prove native credential reference support/);
    expect(turns).not.toHaveBeenCalled();
  });

  it("carries only the public reference on a supported explicit native turn", () => {
    const options = promptOptionsFromTurnInput({ prompt: "research", providerOptions: {
      backend: { type: "claude-code", profile, model: native },
    } }, { provider: "tangle-sandbox", environmentId: "box" });
    expect(options.backend?.model).toEqual(native);
    expect(() => promptOptionsFromTurnInput({ prompt: "research", providerOptions: {
      backend: { type: "codex", profile, model: native },
    } }, { provider: "tangle-sandbox", environmentId: "box" })).toThrow(/exact profile harness/);
  });
});
