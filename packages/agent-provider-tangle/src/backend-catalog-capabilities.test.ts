import { describe, expect, it } from "vitest";
import type {
  BackendRegistryEntry,
  BackendRegistryResponse,
  CreateSandboxOptions,
} from "@tangle-network/sandbox";
import type { CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import {
  createTangleProvider,
  type SandboxClientLike,
} from "./index.js";
import { RETAINED_DEPLOYMENT_DOCUMENT, retainedSessionHandle } from "./retained-control-test-helpers.js";

function backend(
  type: string,
  interactions: BackendRegistryEntry["capabilities"]["interactions"],
): BackendRegistryEntry {
  return {
    type,
    name: type,
    description: `${type} backend`,
    capabilities: {
      streaming: true,
      toolUse: true,
      reasoning: true,
      multimodal: false,
      imageInput: false,
      contextWindow: 128_000,
      mcp: true,
      sessions: true,
      configurable: true,
      interactions,
    },
  };
}

function clientWithCatalog(
  result: BackendRegistryResponse | Error,
): SandboxClientLike {
  return {
    async create() {
      throw new Error("not called");
    },
    async fetch() {
      return new Response();
    },
    async listBackends() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("Tangle backend interaction capabilities", () => {
  it.each(["codex", "unavailable", "missing"] as const)(
    "reconstructs %s backend capabilities without assuming the provider default",
    async (reported) => {
      const provider = createTangleProvider({
        defaultBackend: "opencode",
        client: {
          ...clientWithCatalog({
            backends: [backend("codex", ["question"]), backend("opencode", ["permission"])],
            timestamp: new Date(0).toISOString(),
          }),
          async get(id) {
            return {
              id,
              status: "running",
              async *streamPrompt() {},
              session: retainedSessionHandle,
              capabilities: async () => ({
                ...RETAINED_DEPLOYMENT_DOCUMENT,
                interactions: { responseDedupe: true },
              }),
              ...(reported === "missing" ? {} : {
                backend: {
                  async status() {
                    if (reported === "unavailable") throw new Error("runtime unavailable");
                    return { type: reported };
                  },
                },
              }),
            };
          },
        },
      });
      const environment = await provider.get?.("recovered");
      expect(environment?.capabilities?.interactions?.kinds).toEqual(
        reported === "codex" ? ["question"] : undefined,
      );
      expect(environment?.capabilities?.profile.systemPrompt).toEqual({
        replace: reported === "codex", append: false,
      });
    },
  );

  it.each(["profile", "explicit", "mapper"] as const)(
    "uses the %s backend for the created environment capabilities",
    async (route) => {
      const selected = route === "mapper" ? "opencode" : "codex";
      const created: CreateSandboxOptions[] = [];
      const box = {
        id: "selected-backend",
        status: "running",
        async *streamPrompt() {},
        session: retainedSessionHandle,
        capabilities: async () => ({
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          interactions: { responseDedupe: true },
        }),
      };
      const client: SandboxClientLike = {
        ...clientWithCatalog({
          backends: [backend("codex", ["question"]), backend("opencode", ["permission"])],
          timestamp: new Date(0).toISOString(),
        }),
        async create(options) {
          if (options) created.push(options);
          return box;
        },
      };
      const provider = createTangleProvider({
        client,
        ...(route === "explicit" ? { defaultBackend: "opencode" as const } : {}),
        ...(route === "mapper" ? {
          mapCreateInput: () => ({ backend: { type: "opencode" as const, profile: { name: "mapped" } } }),
        } : {}),
      });
      const environment = await provider.create({
        profile: { name: "worker", harness: "codex" },
        ...(route === "explicit" ? { backend: "codex" } : {}),
      });

      expect(created).toHaveLength(1);
      expect(created[0]?.backend?.type).toBe(selected);
      expect(environment.capabilities?.interactions?.kinds).toEqual(
        selected === "codex" ? ["question"] : ["permission"],
      );
      expect(environment.capabilities?.profile.systemPrompt).toEqual(
        selected === "codex" ? { replace: true, append: false } : { replace: false, append: true },
      );
      if (route === "mapper") expect(created[0]?.backend?.profile).toEqual({ name: "mapped" });
      if (route === "profile") expect((await provider.capabilities()).interactions).toBeUndefined();
    },
  );

  it("captures an unkeyed profile before asynchronous capability discovery", async () => {
    const created: CreateSandboxOptions[] = [];
    const input: CreateAgentEnvironmentInput & { profile: { name: string; harness: "codex" | "claude-code" } } = {
      profile: { name: "worker", harness: "codex" },
    };
    const provider = createTangleProvider({
      client: {
        async create(options) {
          await Promise.resolve();
          if (options) created.push(options);
          return { id: "captured", status: "running", async *streamPrompt() {} };
        },
      },
    });
    const pending = provider.create(input);
    input.profile.harness = "claude-code";
    await pending;
    expect(created[0]?.backend).toMatchObject({ type: "codex", profile: { harness: "codex" } });
    expect(Object.isFrozen(created[0]?.backend?.profile)).toBe(true);
  });

  it("advertises only the interactions from the configured backend", async () => {
    const provider = createTangleProvider({
      client: clientWithCatalog({
        backends: [backend("pi", ["permission"])],
        timestamp: new Date(0).toISOString(),
      }),
      defaultBackend: "pi",
    });

    await expect(provider.capabilities()).resolves.toMatchObject({
      interactions: { kinds: ["permission"] },
    });
  });

  it("fails closed when the canonical catalog cannot be read", async () => {
    const provider = createTangleProvider({
      client: clientWithCatalog(new Error("catalog unavailable")),
      defaultBackend: "pi",
    });

    const capabilities = await provider.capabilities();

    expect(capabilities.interactions).toBeUndefined();
  });

  it("fails closed when no configured backend is present in the catalog", async () => {
    const provider = createTangleProvider({
      client: clientWithCatalog({
        backends: [backend("opencode", ["permission", "question", "plan"])],
        timestamp: new Date(0).toISOString(),
      }),
      defaultBackend: "pi",
    });

    const capabilities = await provider.capabilities();

    expect(capabilities.interactions).toBeUndefined();
  });
});
