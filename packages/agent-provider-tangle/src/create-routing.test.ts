import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import { createTangleProvider } from "./index.js";
import { promptOptionsFromTurnInput } from "./tangle-prompt.js";

const profile = { name: "worker", harness: "opencode" as const };
const routing = { only: ["zai"], allowFallbacks: false, requireModel: true };

/** Drive the maintained Sandbox SDK client and keep the create request it sends. */
async function createRequest(providerOptions: Record<string, unknown>) {
  const requests: { method: string; url: string; body?: unknown }[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    requests.push({ method: request.method, url: request.url, ...(text ? { body: JSON.parse(text) } : {}) });
    return new Response(JSON.stringify({ error: { code: "FIXTURE_STOP", message: "fixture stops after the request" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const provider = createTangleProvider({
      client: new Sandbox({ baseUrl: "https://sandbox.example", apiKey: "fixture-api-key" }),
    });
    await expect(provider.create({ profile, providerOptions })).rejects.toThrow();
  } finally {
    fetch.mockRestore();
  }
  return requests.find((r) => r.method === "POST" && new URL(r.url).pathname === "/v1/sandboxes");
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
