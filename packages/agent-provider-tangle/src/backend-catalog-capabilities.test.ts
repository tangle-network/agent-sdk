import { describe, expect, it } from "vitest";
import type {
  BackendRegistryEntry,
  BackendRegistryResponse,
} from "@tangle-network/sandbox";
import {
  createTangleProvider,
  type SandboxClientLike,
} from "./index.js";

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
