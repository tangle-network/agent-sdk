import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import type { BackendRegistryEntry, CreateSandboxOptions } from "@tangle-network/sandbox";
import { createTangleProvider } from "./index.js";
import type { TangleProviderOptions } from "./index.js";
import { promptOptionsFromTurnInput } from "./tangle-prompt.js";

const profile = { name: "researcher", harness: "opencode" as const };
const attachments = {
  mcp: {
    coordination: {
      transport: "http" as const,
      url: "https://coordination.example/mcp/actor",
      headers: { Authorization: { kind: "secret-ref" as const, key: "COORDINATION_TOKEN", format: "bearer" as const } },
    },
  },
};

function setup(supported = true, mapper?: TangleProviderOptions["mapCreateInput"]) {
  const creates: CreateSandboxOptions[] = [];
  const backend = {
    type: "opencode", name: "OpenCode", description: "fixture",
    capabilities: {
      streaming: true, toolUse: true, reasoning: true, multimodal: false,
      imageInput: false, contextWindow: 128_000, mcp: true, sessions: true,
      configurable: true, interactions: [],
      ...(supported ? { runtimeAttachments: { mcp: true } } : {}),
    },
  } as BackendRegistryEntry;
  const provider = createTangleProvider({
    client: {
      async getBackend() { return backend; },
      async create(options) {
        creates.push(options ?? {});
        return { id: "sandbox-attachment", status: "running", async *streamPrompt() {} };
      },
    },
    ...(mapper ? { mapCreateInput: mapper } : {}),
  });
  return { creates, provider };
}

describe("Tangle runtime attachments", () => {
  it("advertises the adapter transport before a harness is selected", async () => {
    expect((await setup().provider.capabilities()).create?.runtimeAttachments).toEqual({ mcp: true });
  });

  it("carries authenticated coordination separately from the exact profile", async () => {
    const { provider, creates } = setup();
    await provider.create({ profile, runtimeAttachments: attachments, env: { COORDINATION_TOKEN: "private-token" } });
    expect(creates).toHaveLength(1);
    expect(creates[0]?.backend?.profile).toEqual(profile);
    expect(creates[0]?.backend).toHaveProperty("runtimeAttachments", attachments);
    expect(JSON.stringify(creates[0]?.backend)).not.toContain("private-token");
    expect(profile).not.toHaveProperty("mcp");
  });

  it("refuses an unsupported deployment before provisioning", async () => {
    const { provider, creates } = setup(false);
    await expect(provider.create({ profile, runtimeAttachments: attachments })).rejects.toThrow(/runtime attachments.*not supported/i);
    expect(creates).toHaveLength(0);
  });

  it.each([false, true])("refuses a profile alias collision, including a disabled entry (%s)", async (enabled) => {
    const { provider, creates } = setup();
    await expect(provider.create({
      profile: { ...profile, mcp: { coordination: enabled ? { ...attachments.mcp.coordination, enabled } : { enabled } } },
      runtimeAttachments: attachments,
    })).rejects.toThrow(/conflict.*profile/i);
    expect(creates).toHaveLength(0);
  });

  it("refuses disabled runtime attachments", async () => {
    const { provider, creates } = setup();
    await expect(provider.create({ profile, runtimeAttachments: {
      mcp: { coordination: { enabled: false } },
    } })).rejects.toThrow(/cannot be disabled/i);
    expect(creates).toHaveLength(0);
  });

  it("refuses a custom mapper that drops the selected attachments", async () => {
    const { provider, creates } = setup(true, () => ({ backend: { type: "opencode", profile } }));
    await expect(provider.create({ profile, runtimeAttachments: attachments })).rejects.toThrow(/preserve.*runtime attachments/i);
    expect(creates).toHaveLength(0);
  });

  it("carries the same attachment contract on a turn", () => {
    const options = promptOptionsFromTurnInput({
      prompt: "Continue the research",
      providerOptions: { backend: { type: "opencode", profile, runtimeAttachments: attachments } },
    }, { provider: "tangle-sandbox", environmentId: "sandbox-attachment" });
    expect(options.backend).toHaveProperty("runtimeAttachments", attachments);
  });

  it("preserves coordination on the maintained SDK HTTP create and credential-only turn", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const catalog = {
      backends: [{
        type: "opencode", name: "OpenCode", description: "fixture",
        capabilities: {
          streaming: true, toolUse: true, reasoning: true, multimodal: false,
          imageInput: false, contextWindow: 128_000, mcp: true, sessions: true,
          configurable: true, interactions: [], runtimeAttachments: { mcp: true },
        },
      }],
      timestamp: new Date(0).toISOString(),
    };
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      requests.push({ url, body });
      if (url.endsWith("/v1/backends")) return json(catalog);
      if (url.endsWith("/v1/sandboxes") || url.endsWith("/v1/sandboxes/sandbox-attachment")) {
        return json({
          id: "sandbox-attachment", status: "running", createdAt: new Date(0).toISOString(),
          filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
          filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
          connection: { runtimeUrl: "https://sandbox.example/runtime", authToken: "fixture-runtime-token", edgeStatus: "ready" },
        });
      }
      if (url.endsWith("/capabilities")) return new Response("", { status: 404 });
      if (url.endsWith("/agents/run/stream")) {
        return new Response('id: event-1\nevent: done\ndata: {"status":"completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`Unexpected SDK request: ${url}`);
    });
    try {
      const provider = createTangleProvider({ client: new Sandbox({ baseUrl: "https://sandbox.example", apiKey: "fixture-api-key" }) });
      const environment = await provider.create({ profile, runtimeAttachments: attachments, env: { COORDINATION_TOKEN: "private-token" } });
      for await (const _event of environment.stream({
        prompt: "Continue research",
        providerOptions: { backend: { type: "opencode", model: { apiKeyEnv: "MODEL_TOKEN" } } },
      })) {}
      const create = requests.find((request) => request.url.endsWith("/v1/sandboxes"));
      const turn = requests.find((request) => request.url.endsWith("/agents/run/stream"));
      expect(create?.body.backend).toMatchObject({ profile, runtimeAttachments: attachments });
      expect(turn?.body.backend).toMatchObject({ profile, runtimeAttachments: attachments, model: { apiKeyEnv: "MODEL_TOKEN" } });
      expect(JSON.stringify(turn?.body)).not.toContain("private-token");
    } finally {
      fetch.mockRestore();
    }
  });
});
