import { describe, expect, it } from "vitest";
import type {
  BackendRegistryEntry,
  BackendRegistryResponse,
} from "@tangle-network/sandbox";
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
    const error = new Error("catalog unavailable");
    const provider = createTangleProvider({
      client: clientWithCatalog(error),
      defaultBackend: "pi",
    });

    await expect(provider.capabilities()).rejects.toBe(error);
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
