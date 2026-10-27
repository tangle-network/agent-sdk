import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import { createTangleProvider } from "./index.js";
import { RETAINED_DEPLOYMENT_DOCUMENT } from "./retained-control-test-helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const profile = { name: "root", harness: "claude-code" as const };
const proof = { hostId: "fixture-host", containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, bundleRevision: "c".repeat(40), bundleChecksum: `sha256:${"d".repeat(64)}` };

/** A real SDK transport: credential preflight refuses before a backend is selected. */
async function fixture(code: string, status = 503) {
  const requests: string[] = [];
  let metadata: unknown;
  const info = () => ({
    id: "sandbox-predispatch", status: "running", createdAt: new Date(0).toISOString(), metadata,
    filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
    filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
    captureProof: proof, createReceipt: { outcome: "created", idempotencyKeyApplied: true, captureProof: proof },
  });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    requests.push(`${request.method} ${path}`);
    response.setHeader("content-type", "application/json");
    if (path === "/v1/backends") {
      response.end(JSON.stringify({ backends: [], timestamp: new Date(0).toISOString() }));
    } else if (path === "/v1/sandboxes" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      metadata = JSON.parse(Buffer.concat(chunks).toString()).metadata;
      response.end(JSON.stringify(info()));
    } else if (path === "/v1/sandboxes/sandbox-predispatch") {
      response.end(JSON.stringify(info()));
    } else if (path.endsWith("/capabilities")) {
      response.end(JSON.stringify({ ...RETAINED_DEPLOYMENT_DOCUMENT, nativeSessionCaptureVersion: 2, nativeSessionCaptureHarnesses: ["claude-code"] }));
    } else if (path.endsWith("/agents/run/stream") && request.method === "POST") {
      response.writeHead(status);
      response.end(JSON.stringify({ status: "error", code, message: "Sandbox Hub credential is temporarily unavailable." }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ code: "NOT_FOUND", message: "Backend or session not selected" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP fixture address");
  const provider = createTangleProvider({ client: new Sandbox({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "fixture-key" }), modelCredentials: { apiKeyEnv: "FIXTURE_MODEL", baseUrl: "https://model.invalid" }, requireNativeSessionCapture: true });
  const environment = await provider.create({ profile, idempotencyKey: "runtime:fixture" });
  return { provider, environment, requests };
}

it("preserves positive predispatch refusal through the real SDK without relaxing native reconnect", async () => {
  const { provider, environment, requests } = await fixture("HUB_CREDENTIAL_REFRESH_FAILED");
  const error = await environment.dispatch!({ prompt: "research", turnId: "root:0", profile }).catch((error: unknown) => error);
  expect(error).toMatchObject({ status: 503, code: "HUB_CREDENTIAL_REFRESH_FAILED", dispatchFailureDisposition: "not-admitted" });
  await expect(provider.get!(environment.id)).rejects.toThrow(/requires the current selected backend before reconnect/);
  expect(requests.filter((request) => request === "POST /v1/sandboxes/sandbox-predispatch/runtime/agents/run/stream")).toHaveLength(1);
});

it.each([["SERVER_ERROR", 503], ["HUB_CREDENTIAL_REFRESH_FAILED", 502]])("keeps ambiguous %s HTTP %s failures uncertain", async (code, status) => {
  const { environment } = await fixture(code, status);
  const error = await environment.dispatch!({ prompt: "research", turnId: "root:0", profile }).catch((error: unknown) => error);
  expect(error).toMatchObject({ status, code });
  expect(error).not.toHaveProperty("dispatchFailureDisposition");
});
