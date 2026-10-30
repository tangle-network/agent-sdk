import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import type { CreateAgentEnvironmentInput, ProxySecretBinding, ProxySecretReceipt } from "@tangle-network/agent-interface/environment-provider";
import { createTangleProvider } from "@tangle-network/agent-provider-tangle";
import { installedProxyReceipt } from "./fixtures/proxy-secret-receipt.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const profile = { name: "host-binding", harness: "opencode" as const };
const host = "reports.example.com", runtimeAttachments = { mcp: { public: { transport: "http" as const, url: "https://mcp.example.com" } } };
const binding = (name = "REPORTS_TOKEN"): ProxySecretBinding => ({
  envName: name, secretRef: { kind: "secret-ref", key: name }, hosts: [host],
  presentation: { type: "bearer" },
});
const selected = (name = "REPORTS_TOKEN") => ({ name, host, header: "Authorization" });
const exposed = { name: "READABLE_NAME", exposeInBox: true as const };
async function fixture(proxySecretReceipt?: ProxySecretReceipt) {
  let baseUrl = "", metadata: unknown;
  const requests: string[] = [], creates: Record<string, unknown>[] = [], turns: Record<string, unknown>[] = [], stored = new Map<string, string>(), policies = new Map<string, Record<string, unknown>>();
  const info = () => ({
    id: "sandbox-bindings", status: "running", createdAt: new Date(0).toISOString(), metadata, proxySecretReceipt,
    filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
    filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
    connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/sandbox-bindings/runtime`, authToken: "fixture-runtime-token", edgeStatus: "ready" },
  });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    requests.push(`${request.method} ${path}`);
    response.setHeader("content-type", "application/json");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (path === "/v1/backends") {
      response.end(JSON.stringify({ backends: ["opencode", "claude-code", "codex"].map((type) => ({ type, name: type, description: "HTTP fixture", callerCredentialOnly: false, capabilities: { streaming: true, toolUse: true, reasoning: false, multimodal: false, imageInput: false, contextWindow: 100000, mcp: true, sessions: true, configurable: true, interactions: [], runtimeAttachments: { mcp: true } } })), timestamp: new Date(0).toISOString() }));
    } else if (path === "/v1/secrets" && request.method === "POST") {
      stored.set(body.name, body.value); const { value: _value, ...policy } = body; policies.set(body.name, policy);
      response.end(JSON.stringify({ secret: { ...policy, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } }));
    } else if (path.startsWith("/v1/secrets/") && request.method === "DELETE") {
      stored.delete(decodeURIComponent(path.slice("/v1/secrets/".length)));
      response.end(JSON.stringify({ success: true }));
    } else if (path === "/v1/sandboxes" && request.method === "POST") {
      creates.push(body); metadata = body.metadata;
      response.end(JSON.stringify(info()));
    } else if (path === "/v1/sandboxes/sandbox-bindings") {
      response.end(JSON.stringify(info()));
    } else if (path.endsWith("/agents/run/stream")) {
      turns.push(body); response.setHeader("content-type", "text/event-stream"); response.end(`event: result\ndata: ${JSON.stringify({ executionId: body.executionId ?? request.headers["x-execution-id"], success: true, status: "success", response: "fixture", durationMs: 1 })}\n\nevent: done\ndata: {"outcome":{"type":"completed"}}\n\n`);
    } else if (path.endsWith("/capabilities")) {
      response.end(JSON.stringify({ schema: 1, cliAuthReferences: true, agentInterface: "0.49.0", sidecarVersion: "1.0.0-test", dispatch: { runControlRef: false, executionIdOnAdmission: false }, cancel: { canonicalRunCancellation: false, digestBound: false, idempotent: false }, runs: { executionScopedStatus: false, eventReplay: false }, interactions: { responseDedupe: false }, image: `example/sidecar@sha256:${"a".repeat(64)}` }));
    } else {
      response.writeHead(404); response.end(JSON.stringify({ code: "NOT_FOUND", message: "No receipt protocol is served" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP fixture address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return { client: new Sandbox({ baseUrl, platformUrl: baseUrl, apiKey: "fixture-api-key", trustLocalCliAuth: false, directExec: false }), creates, requests, stored, turns, policies };
}
it.each([{ secrets: undefined }, { secrets: [] }, { secrets: ["BARE_NAME", exposed] }, { secrets: "all" as const }, { secrets: [selected(), { name: "CUSTOM_HEADER", host, header: "X-Api-Key" }, { name: "DEFAULT_HEADER", host }] }])("preserves legacy delivery without inventing consent (%j)", async ({ secrets }) => {
  const { client, creates, requests } = await fixture();
  const provider = createTangleProvider({ client });
  const environment = await provider.create({ profile, secrets, egress: { mode: "open" }, billingOwner: "fixture-owner", runtimeAttachments, metadata: { reason: "fixture-customer Git auth" } });
  expect(environment.id).toBe("sandbox-bindings");
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({ egressPolicy: { mode: "open" }, billingOwnerId: "fixture-owner", metadata: { reason: "fixture-customer Git auth" }, backend: { profile, runtimeAttachments } }); expect(creates[0]!.secrets).toEqual(secrets);
  if (secrets === undefined) expect(creates[0]).not.toHaveProperty("secrets");
  expect(creates[0]).not.toHaveProperty("proxySecrets");
  expect(requests.some((request) => request.endsWith("/egress"))).toBe(false);
  expect(requests).not.toContain("GET /v1/capabilities");
});
it("forwards authored and runtime declarations as the one full canonical schema", async () => {
  const { client, creates } = await fixture();
  const basic = { ...binding("GIT_TOKEN"), presentation: { type: "basic" as const, username: "git" } };
  const custom = { ...binding("HEADER_TOKEN"), presentation: { type: "header" as const, name: "X-Api-Key" } };
  await createTangleProvider({ client }).create({
    profile: { ...profile, proxySecrets: [binding()] }, proxySecrets: [basic, custom],
    secrets: ["READABLE_NAME"],
  });
  expect(creates).toHaveLength(1);
  expect(creates[0]!.secrets).toEqual(["READABLE_NAME"]);
  expect(creates[0]!.proxySecrets).toEqual([binding(), basic, custom]);
});
it.each([
  { ...binding(), methods: ["POST"] },
  { ...binding(), paths: ["/v1/events"] },
  { ...binding(), presentation: { type: "query" as const, name: "key" } },
  { ...binding(), placeholderFormat: "jwt" as const },
  { ...binding(), envName: "ALIAS" },
  { ...binding(), hosts: [host, "other.example.com"] },
  { ...binding(), ttlSeconds: 60 },
])("preserves canonical scope and presentation without lossy lowering (%j)", async (declaration) => {
  const { client, creates } = await fixture();
  await createTangleProvider({ client }).create({ profile: { ...profile, proxySecrets: [declaration] }, proxySecrets: [declaration] });
  expect(creates[0]!.proxySecrets).toEqual([declaration]);
  expect(creates[0]!.secrets).toEqual([]);
});
it.each([
  { secrets: [selected()], env: { REPORTS_TOKEN: "inline-readable" } },
  { secrets: [selected(), { ...selected(), host: "other.example.com" }] },
  { secrets: [selected()], proxySecrets: [{ ...binding(), hosts: ["other.example.com"] }] },
  { secrets: [selected(exposed.name), exposed] }, { secrets: [exposed.name, exposed] },
  { secrets: [{ name: "REPORTS_TOKEN", exposeInBox: true as const }], proxySecrets: [binding()] },
])("refuses conflicting or readable delivery before allocation (%j)", async (input) => {
  const { client, creates } = await fixture();
  await expect(createTangleProvider({ client }).create({ profile, ...input })).rejects.toThrow();
  expect(creates).toHaveLength(0);
});
it.each([
  { requested: selected(), secrets: undefined }, { requested: selected(), secrets: ["REPORTS_TOKEN"] },
  { requested: selected(), secrets: [{ ...selected(), host: "other.example.com" }] },
  { requested: selected(), secrets: [{ ...selected(), header: "X-Other" }] },
  { requested: selected(), secrets: [{ name: "REPORTS_TOKEN", exposeInBox: true as const }] },
  { requested: exposed, secrets: undefined }, { requested: exposed, secrets: [exposed.name] }, { requested: exposed, secrets: [exposed] },
])("refuses a custom mapper that changes an explicit delivery selection (%j)", async ({ requested, secrets }) => {
  const { client, creates } = await fixture();
  const provider = createTangleProvider({ client, mapCreateInput: () => ({
    backend: { type: "opencode", profile }, ...(secrets === undefined ? {} : { secrets }),
  }) });
  await expect(provider.create({ profile, secrets: [requested], metadata: { reason: "fixture-customer Git auth" } })).rejects.toThrow();
  expect(creates).toHaveLength(0);
});
it.each([{ secrets: [{ name: "REPORTS_TOKEN", exposeInBox: true as const }] }, { secrets: [{ ...selected(), host: "other.example.com" }] }])(
  "refuses a custom mapper that loses a portable declaration (%j)", async ({ secrets }) => {
    const { client, creates } = await fixture();
    const provider = createTangleProvider({ client, mapCreateInput: () => ({
      backend: { type: "opencode", profile }, ...(secrets === undefined ? {} : { secrets }),
    }) });
    await expect(provider.create({ profile, proxySecrets: [binding()] })).rejects.toThrow();
    expect(creates).toHaveLength(0);
  },
);
it("detaches mapper selectors and preserves consent plus equivalent headers", async () => {
  const { client, creates } = await fixture();
  const secrets = [selected(), exposed], declarations = [binding()];
  const provider = createTangleProvider({ client, mapCreateInput: () => {
    queueMicrotask(() => { secrets[0]!.name = "CHANGED_NAME"; declarations[0]!.hosts = ["changed.example.com"]; });
    return { backend: { type: "opencode", profile, runtimeAttachments }, secrets, proxySecrets: declarations };
  } });
  await provider.create({ profile, proxySecrets: [binding()], secrets: [{ name: "REPORTS_TOKEN", host, header: "authorization" }, exposed] });
  expect(creates[0]!.secrets).toEqual([selected(), exposed]); expect(creates[0]!.proxySecrets).toEqual([binding()]);
});
it("refuses value-bearing maps and undeclared host binding fields before allocation", async () => {
  const { client, creates } = await fixture();
  const provider = createTangleProvider({ client });
  for (const secrets of [
    { REPORTS_TOKEN: "inline-readable" },
    [{ ...selected(), value: "inline-readable" }],
    [{ ...selected(), host: "https://reports.example.com" }],
    [{ ...selected(), header: "X-Key\r\nInjected: yes" }],
    [{ ...exposed, host }], [{ ...exposed, exposeInBox: false }], [{ ...exposed, header: "Authorization" }],
  ]) {
    await expect(provider.create({ profile, secrets } as CreateAgentEnvironmentInput)).rejects.toThrow();
  }
  expect(creates).toHaveLength(0);
});
it("keeps semantic host identity and legacy model intent canonical across SDK versions", async () => {
  const { client, creates, turns } = await fixture(installedProxyReceipt);
  const routing = { only: ["fixture-router"], allowFallbacks: false }, model = { provider: "openai", model: "fixture-model", apiKeyEnv: "MODEL_TOKEN", baseUrl: "https://model.example.com" };
  const environment = await createTangleProvider({ client, mapCreateInput: () => ({ backend: { type: "opencode", profile, modelId: model.model, provider: model.provider, apiKeyEnv: model.apiKeyEnv, baseUrl: model.baseUrl, routing }, secrets: [{ name: "REPORTS_TOKEN", host }] }) })
    .create({ profile, secrets: [{ host, name: "REPORTS_TOKEN" }], proxySecrets: [binding()], providerOptions: { routing } });
  expect(creates[0]!.secrets).toEqual([expect.objectContaining({ name: "REPORTS_TOKEN", host })]);
  expect(creates[0]!.backend).toMatchObject({ model: { ...model, routing } });
  for await (const _ of environment.stream({ prompt: "Transport intent only", providerOptions: { backend: { type: "opencode", modelId: model.model, provider: model.provider, apiKeyEnv: model.apiKeyEnv, baseUrl: model.baseUrl } } })) {}
  expect(turns[0]!.backend).toMatchObject({ model });
  for (const backend of [{ modelId: "first", model: { model: "other" } }, { routing }, { unsupported: true }]) {
    await expect((async () => { for await (const _ of environment.stream({ prompt: "Refuse before HTTP", providerOptions: { backend } })) {} })()).rejects.toThrow();
  }
  expect(turns).toHaveLength(1);
});
it.each([{ secrets: undefined }, { secrets: ["REPORTS_TOKEN"] }, { secrets: "all" as const }])("preserves canonical custody alongside legacy selection %j", async ({ secrets }) => {
  const { client, creates } = await fixture();
  await createTangleProvider({ client, mapCreateInput: () => ({ backend: { type: "opencode", profile }, ...(secrets === undefined ? {} : { secrets: typeof secrets === "string" ? secrets : [...secrets] }) }) })
    .create({ profile, proxySecrets: [binding()], ...(secrets === undefined ? {} : { secrets: typeof secrets === "string" ? secrets : [...secrets] }) });
  expect(creates[0]!.proxySecrets).toEqual([binding()]); expect(creates[0]!.secrets).toEqual(secrets);
});
it("exposes only a fenced provider store while the SDK basic store stays usable", async () => {
  const { client, stored, requests, policies } = await fixture();
  const provider = createTangleProvider({ client });
  const value = randomBytes(32).toString("hex");
  expect(provider.secrets !== undefined).toBe("update" in client.secrets);
  const policy = { proxySecrets: [binding()], reason: "fixture-retained reason" };
  const receipt = provider.secrets ? await provider.secrets.create("COORDINATION_RUN_TOKEN", value, policy) : await client.secrets.create("COORDINATION_RUN_TOKEN", value);
  if (provider.secrets) { expect(policies.get("COORDINATION_RUN_TOKEN")).toMatchObject(policy); expect(receipt).toMatchObject(policy); }
  expect(receipt).toMatchObject({ name: "COORDINATION_RUN_TOKEN" });
  expect(stored.get("COORDINATION_RUN_TOKEN") === value).toBe(true);
  await (provider.secrets ?? client.secrets).delete("COORDINATION_RUN_TOKEN");
  expect(stored.has("COORDINATION_RUN_TOKEN")).toBe(false);
  expect(requests).toEqual(["POST /v1/secrets", "DELETE /v1/secrets/COORDINATION_RUN_TOKEN"]);
});
it("preserves HTTPS8443 plan-key declarations without a second port selector", async () => {
  const { client, creates } = await fixture();
  await createTangleProvider({ client, modelCredentials: {
    apiKeyEnv: "REPORTS_TOKEN", baseUrl: `https://${host}:8443`, proxySecrets: [binding()],
  } }).create({ profile });
  expect(creates[0]!.proxySecrets).toEqual([binding()]);
  expect(creates[0]!.backend).toMatchObject({ model: { apiKeyEnv: "REPORTS_TOKEN", baseUrl: `https://${host}:8443` } });
  expect((creates[0]!.backend as { model: unknown }).model).not.toHaveProperty("proxySecrets");
});
it.each(["claude-code", "codex"] as const)("preserves native %s existing stored selection and descriptor", async (harness) => {
  const { client, creates } = await fixture();
  const cliAuth = { account: "fixture-native", secretEnv: "NATIVE_BUNDLE", format: harness === "codex" ? "bundle" as const : "token" as const };
  await createTangleProvider({ client, modelCredentials: { cliAuth } }).create({ profile: { harness, model: { metadata: { credentialSource: "subscription" } } }, secrets: ["UNRELATED"] });
  expect(creates[0]!.secrets).toEqual(["UNRELATED", "NATIVE_BUNDLE"]); expect(creates[0]!.backend).toMatchObject({ model: { cliAuth, authMode: "oauth" } });
});
it.each(["/v1/..;/admin", "/v1/events;format=json", "/v1/%2e%2e/admin"])("rejects ambiguous canonical path %s before allocation", async (path) => { const { client, creates } = await fixture();
  await expect(createTangleProvider({ client }).create({ profile, proxySecrets: [{ ...binding(), paths: [path] }] })).rejects.toThrow(/canonical ASCII/); expect(creates).toHaveLength(0);
});
