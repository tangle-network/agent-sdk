import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import { createTangleProvider } from "./index.js";
import { promptOptionsFromTurnInput } from "./tangle-prompt.js";

const profile = { name: "worker", harness: "opencode" as const };
const routing = { only: ["zai"], allowFallbacks: false, requireModel: true };

/** Drive the maintained Sandbox SDK client and keep the create request it sends. */
async function createRequest(providerOptions: Record<string, unknown>) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = request.method === "GET" ? "" : await request.text();
    requests.push({ method: request.method, path, ...(text ? { body: JSON.parse(text) } : {}) });
    if (path === "/v1/sandboxes" || path === "/v1/sandboxes/sandbox-routing") {
      return json({
        id: "sandbox-routing", status: "running", createdAt: new Date(0).toISOString(),
        filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
        filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
        connection: { runtimeUrl: "https://sandbox.example/runtime", authToken: "fixture-runtime-token", edgeStatus: "ready" },
      });
    }
    if (path.endsWith("/capabilities")) return new Response("", { status: 404 });
    throw new Error(`Unexpected SDK request: ${request.method} ${path}`);
  });
  try {
    const provider = createTangleProvider({
      client: new Sandbox({ baseUrl: "https://sandbox.example", apiKey: "fixture-api-key" }),
    });
    await provider.create({ profile, providerOptions });
  } finally {
    fetch.mockRestore();
  }
  return requests.find((r) => r.method === "POST" && r.path === "/v1/sandboxes");
}

describe("Tangle create routing", () => {
  it("sends providerOptions.routing as the Sandbox create backend routing", async () => {
    const create = await createRequest({ routing });
    expect(create, "the SDK sent a create request").toBeDefined();
    expect((create?.body as { backend?: { model?: { routing?: unknown } } }).backend?.model?.routing).toEqual(routing);
  });

  it.each([
    [{ other: true }, /accept only routing/],
    [{ routing: { only: [] } }, /non-empty list/],
    [{ routing: { allowFallbacks: "no" } }, /must be a boolean/],
    [{ routing: { region: "us" } }, /accepts only only, allowFallbacks, requireModel/],
  ])("refuses %j before any request", async (providerOptions, message) => {
    const create = vi.fn();
    const provider = createTangleProvider({ client: { create } });
    await expect(provider.create({ profile, providerOptions })).rejects.toThrow(message);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a mapper that drops the requested routing", async () => {
    const create = vi.fn();
    const provider = createTangleProvider({
      client: { create },
      mapCreateInput: () => ({ backend: { type: "opencode", profile } }),
    });
    await expect(provider.create({ profile, providerOptions: { routing } })).rejects.toThrow(/requested providerOptions.routing/);
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves per-turn routing to the SDK, which refuses it", () => {
    expect(() => promptOptionsFromTurnInput({
      prompt: "run",
      providerOptions: { backend: { type: "opencode", routing } },
    }, { provider: "tangle-sandbox", environmentId: "sandbox-routing" })).toThrow(/creation only/);
  });
});
