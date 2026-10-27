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
  const creates: Record<string, unknown>[] = [], dispatches: Record<string, unknown>[] = [];
  let admit = false;
  let baseUrl = "";
  let metadata: unknown;
  const info = () => ({
    id: "sandbox-predispatch", status: "running", createdAt: new Date(0).toISOString(), metadata,
    filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
    filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
    connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/sandbox-predispatch/runtime`, authToken: "fixture-runtime-token", edgeStatus: "ready" },
    captureProof: proof, createReceipt: { outcome: creates.length > 1 ? "idempotent_replay" : "created", idempotencyKeyApplied: true, captureProof: proof },
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
      const input = JSON.parse(Buffer.concat(chunks).toString());
      creates.push(input);
      metadata = input.metadata;
      response.end(JSON.stringify(info()));
    } else if (path === "/v1/sandboxes/sandbox-predispatch") {
      response.end(JSON.stringify(info()));
    } else if (path.endsWith("/capabilities")) {
      response.end(JSON.stringify({ ...RETAINED_DEPLOYMENT_DOCUMENT, interactions: {}, nativeSessionCaptureVersion: 2, nativeSessionCaptureHarnesses: ["claude-code"] }));
    } else if (path.endsWith("/messages/turns")) {
      response.writeHead(204);
      response.end();
    } else if (path.endsWith("/agents/run/stream") && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString());
      dispatches.push(input);
      if (admit) {
        response.setHeader("content-type", "text/event-stream");
        response.end(`event: execution.started\ndata: ${JSON.stringify({ executionId: input.executionId, sessionId: input.sessionId, runControlRef: input.runControlRef })}\n\n`);
      } else {
        response.writeHead(status);
        response.end(JSON.stringify({ status: "error", code, message: "Sandbox Hub credential is temporarily unavailable." }));
      }
    } else if (path.endsWith("/backend") && admit) {
      response.end(JSON.stringify({ type: "claude-code" }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ code: "NOT_FOUND", message: "Backend or session not selected" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP fixture address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const reconnect = () => createTangleProvider({ client: new Sandbox({ baseUrl, apiKey: "fixture-key" }), modelCredentials: { apiKeyEnv: "FIXTURE_MODEL", baseUrl: "https://model.invalid" }, requireNativeSessionCapture: true });
  const provider = reconnect();
  const environment = await provider.create({ profile, idempotencyKey: "runtime:fixture" });
  return { provider, environment, requests, creates, dispatches, reconnect, allowDispatch: () => { admit = true; } };
}

it("starts the refused turn after original-key create replay without requiring a previously selected backend", async () => {
  const { provider, environment, requests, creates, dispatches, reconnect, allowDispatch } = await fixture("HUB_CREDENTIAL_REFRESH_FAILED");
  const turn = { prompt: "research", turnId: "root:0", profile };
  const error = await environment.dispatch!(turn).catch((error: unknown) => error);
  expect(error, JSON.stringify(requests)).toMatchObject({ status: 503, code: "HUB_CREDENTIAL_REFRESH_FAILED" });
  await expect(provider.get!(environment.id)).rejects.toThrow(/requires the current selected backend before reconnect/);
  allowDispatch();
  const replayed = await reconnect().create({ profile, idempotencyKey: "runtime:fixture" });
  const reference = await replayed.dispatch!(turn);
  expect(replayed.id).toBe(environment.id);
  expect(replayed.creation).toBe("replayed");
  expect(creates).toHaveLength(2);
  expect(creates.map((input) => input.idempotencyKey)).toEqual(["runtime:fixture", "runtime:fixture"]);
  expect(dispatches).toHaveLength(2);
  expect(dispatches[1]).toEqual(dispatches[0]);
  expect(reference.controlRef).toEqual(dispatches[0]!.runControlRef);
  expect(reference.metadata).toMatchObject({ dispatched: true });
});

it.each([["SERVER_ERROR", 503], ["HUB_CREDENTIAL_REFRESH_FAILED", 502]])("preserves the SDK's %s HTTP %s error", async (code, status) => {
  const { environment, requests } = await fixture(code, status);
  const error = await environment.dispatch!({ prompt: "research", turnId: "root:0", profile }).catch((error: unknown) => error);
  expect(error, JSON.stringify(requests)).toMatchObject({ status, code });
});
