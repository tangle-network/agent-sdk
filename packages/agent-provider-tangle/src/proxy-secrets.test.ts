import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import type { CreateAgentEnvironmentInput, ProxySecretBinding } from "@tangle-network/agent-interface/environment-provider";
import { createTangleProvider } from "@tangle-network/agent-provider-tangle";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const profile = { name: "host-binding", harness: "opencode" as const };
const host = "reports.example.com";
const binding = (name = "REPORTS_TOKEN"): ProxySecretBinding => ({
  envName: name, secretRef: { kind: "secret-ref", key: name }, hosts: [host],
  presentation: { type: "bearer" },
});
const selected = (name = "REPORTS_TOKEN") => ({ name, host, header: "Authorization" });

/** Actual Sandbox HTTP transport; this peer checks wire delivery, not proxy enforcement. */
async function fixture() {
  let baseUrl = "", metadata: unknown;
  const requests: string[] = [], creates: Record<string, unknown>[] = [], stored = new Map<string, string>();
  const info = () => ({
    id: "sandbox-bindings", status: "running", createdAt: new Date(0).toISOString(), metadata,
    filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
    filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
    connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/sandbox-bindings/runtime`, authToken: "fixture-runtime-token", edgeStatus: "ready" },
  });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    requests.push(`${request.method} ${path}`);
    response.setHeader("content-type", "application/json");
    if (path === "/v1/backends") {
      response.end(JSON.stringify({ backends: [], timestamp: new Date(0).toISOString() }));
    } else if (path === "/v1/secrets" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      stored.set(body.name, body.value);
      response.end(JSON.stringify({ secret: { name: body.name, createdAt: new Date(0).toISOString() } }));
    } else if (path.startsWith("/v1/secrets/") && request.method === "DELETE") {
      stored.delete(decodeURIComponent(path.slice("/v1/secrets/".length)));
      response.end(JSON.stringify({ success: true }));
    } else if (path === "/v1/sandboxes" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      creates.push(body); metadata = body.metadata;
      response.end(JSON.stringify(info()));
    } else if (path === "/v1/sandboxes/sandbox-bindings") {
      response.end(JSON.stringify(info()));
    } else if (path.endsWith("/capabilities")) {
      response.end(JSON.stringify({ schema: 1, agentInterface: "0.49.0", sidecarVersion: "1.0.0-test", dispatch: { runControlRef: false, executionIdOnAdmission: false }, cancel: { canonicalRunCancellation: false, digestBound: false, idempotent: false }, runs: { executionScopedStatus: false, eventReplay: false }, interactions: {}, image: `example/sidecar@sha256:${"a".repeat(64)}` }));
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
  return { client: new Sandbox({ baseUrl, platformUrl: baseUrl, apiKey: "fixture-api-key", trustLocalCliAuth: false, directExec: false }), creates, requests, stored };
}

it.each([{ secrets: undefined }, { secrets: [selected(), { name: "CUSTOM_HEADER", host, header: "X-Api-Key" }, { name: "DEFAULT_HEADER", host }] }])("forwards ordinary and host-bound creates without custody receipts (%j)", async ({ secrets }) => {
  const { client, creates, requests } = await fixture();
  const provider = createTangleProvider({ client });
  const environment = await provider.create({ profile, secrets });
  expect(environment.id).toBe("sandbox-bindings");
  expect(creates).toHaveLength(1);
  expect(creates[0]!.secrets).toEqual(secrets);
  if (secrets === undefined) expect(creates[0]).not.toHaveProperty("secrets");
  expect(creates[0]).not.toHaveProperty("proxySecrets");
  expect(requests.some((request) => request.endsWith("/egress"))).toBe(false);
  expect(requests).not.toContain("GET /v1/capabilities");
});

it("lowers authored and runtime declarations onto the same stored host entries", async () => {
  const { client, creates } = await fixture();
  const basic = { ...binding("GIT_TOKEN"), presentation: { type: "basic" as const, username: "git" } };
  const custom = { ...binding("HEADER_TOKEN"), presentation: { type: "header" as const, name: "X-Api-Key" } };
  await createTangleProvider({ client }).create({
    profile: { ...profile, proxySecrets: [binding()] }, proxySecrets: [basic, custom],
    secrets: ["READABLE_NAME"],
  });
  expect(creates).toHaveLength(1);
  expect(creates[0]!.secrets).toEqual([
    "READABLE_NAME", selected(), selected("GIT_TOKEN"), { name: "HEADER_TOKEN", host, header: "X-Api-Key" },
  ]);
  expect(creates[0]).not.toHaveProperty("proxySecrets");
});

it("deduplicates identical declarations across profile and runtime input", async () => {
  const { client, creates } = await fixture();
  await createTangleProvider({ client }).create({ profile: { ...profile, proxySecrets: [binding()] }, proxySecrets: [binding()] });
  expect(creates[0]!.secrets).toEqual([selected()]);
});

it.each([
  { ...binding(), methods: ["POST"] },
  { ...binding(), paths: ["/v1/events"] },
  { ...binding(), presentation: { type: "query" as const, name: "key" } },
  { ...binding(), placeholderFormat: "jwt" as const },
  { ...binding(), envName: "ALIAS" },
  { ...binding(), hosts: [host, "other.example.com"] },
  { ...binding(), ttlSeconds: 60 },
])("refuses an unrepresentable declaration before allocation (%j)", async (declaration) => {
  const { client, creates } = await fixture();
  await expect(createTangleProvider({ client }).create({ profile, proxySecrets: [declaration] })).rejects.toThrow(/cannot enforce/);
  expect(creates).toHaveLength(0);
});

it.each([
  { secrets: [selected()], env: { REPORTS_TOKEN: "inline-readable" } },
  { secrets: ["REPORTS_TOKEN"], proxySecrets: [binding()] },
  { secrets: [selected(), { ...selected(), host: "other.example.com" }] },
  { secrets: [selected()], proxySecrets: [{ ...binding(), hosts: ["other.example.com"] }] },
])("refuses conflicting or readable delivery before allocation (%j)", async (input) => {
  const { client, creates } = await fixture();
  await expect(createTangleProvider({ client }).create({ profile, ...input })).rejects.toThrow();
  expect(creates).toHaveLength(0);
});

it.each([
  { secrets: undefined },
  { secrets: ["REPORTS_TOKEN"] },
  { secrets: [{ ...selected(), host: "other.example.com" }] },
  { secrets: [{ ...selected(), header: "X-Other" }] },
])("refuses a custom mapper that changes a direct host selection (%j)", async ({ secrets }) => {
  const { client, creates } = await fixture();
  const provider = createTangleProvider({ client, mapCreateInput: () => ({
    backend: { type: "opencode", profile }, ...(secrets === undefined ? {} : { secrets }),
  }) });
  await expect(provider.create({ profile, secrets: [selected()] })).rejects.toThrow();
  expect(creates).toHaveLength(0);
});

it.each([{ secrets: ["REPORTS_TOKEN"] }, { secrets: [{ ...selected(), host: "other.example.com" }] }])(
  "refuses a custom mapper that loses a portable declaration (%j)", async ({ secrets }) => {
    const { client, creates } = await fixture();
    const provider = createTangleProvider({ client, mapCreateInput: () => ({
      backend: { type: "opencode", profile }, ...(secrets === undefined ? {} : { secrets }),
    }) });
    await expect(provider.create({ profile, proxySecrets: [binding()] })).rejects.toThrow();
    expect(creates).toHaveLength(0);
  },
);

it("accepts a custom mapper that preserves the selected host binding", async () => {
  const { client, creates } = await fixture();
  const provider = createTangleProvider({ client, mapCreateInput: () => ({
    backend: { type: "opencode", profile }, secrets: [selected()],
  }) });
  await provider.create({ profile, secrets: [selected()], proxySecrets: [binding()] });
  expect(creates[0]!.secrets).toEqual([selected()]);
});

it("refuses value-bearing maps and undeclared host binding fields before allocation", async () => {
  const { client, creates } = await fixture();
  const provider = createTangleProvider({ client });
  for (const secrets of [
    { REPORTS_TOKEN: "inline-readable" },
    [{ ...selected(), value: "inline-readable" }],
    [{ ...selected(), host: "https://reports.example.com" }],
    [{ ...selected(), header: "X-Key\r\nInjected: yes" }],
  ]) {
    await expect(provider.create({ profile, secrets } as CreateAgentEnvironmentInput)).rejects.toThrow();
  }
  expect(creates).toHaveLength(0);
});


it("normalizes equivalent direct and portable bindings regardless of property order or default header", async () => {
  const { client, creates } = await fixture();
  await createTangleProvider({ client }).create({ profile,
    secrets: [{ host, name: "REPORTS_TOKEN" }], proxySecrets: [binding()],
  });
  expect(creates[0]!.secrets).toHaveLength(1);
  expect(creates[0]!.secrets).toEqual([expect.objectContaining({ name: "REPORTS_TOKEN", host })]);
});

it("injects lowered portable bindings into a custom mapper's SDK request", async () => {
  const { client, creates } = await fixture();
  await createTangleProvider({ client, mapCreateInput: () => ({ backend: { type: "opencode", profile } }) })
    .create({ profile, proxySecrets: [binding()] });
  expect(creates[0]!.secrets).toEqual([selected()]);
});

it("forwards the host secret store with its receiver intact and deletes the stored value", async () => {
  const { client, stored, requests } = await fixture();
  const provider = createTangleProvider({ client });
  const value = randomBytes(32).toString("hex");
  expect(provider.secrets).toBeDefined();
  const receipt = await provider.secrets!.create("COORDINATION_RUN_TOKEN", value);
  expect(receipt).toMatchObject({ name: "COORDINATION_RUN_TOKEN" });
  expect(stored.get("COORDINATION_RUN_TOKEN") === value).toBe(true);
  await provider.secrets!.delete("COORDINATION_RUN_TOKEN");
  expect(stored.has("COORDINATION_RUN_TOKEN")).toBe(false);
  expect(requests).toEqual(["POST /v1/secrets", "DELETE /v1/secrets/COORDINATION_RUN_TOKEN"]);
});

it("lowers selected plan-key bindings without passing them as backend model options", async () => {
  const { client, creates } = await fixture();
  await createTangleProvider({ client, modelCredentials: {
    apiKeyEnv: "REPORTS_TOKEN", baseUrl: `https://${host}`, proxySecrets: [binding()],
  } }).create({ profile });
  expect(creates[0]!.secrets).toEqual([selected()]);
  expect(creates[0]!.backend).toMatchObject({ model: { apiKeyEnv: "REPORTS_TOKEN", baseUrl: `https://${host}` } });
  expect((creates[0]!.backend as { model: unknown }).model).not.toHaveProperty("proxySecrets");
});
