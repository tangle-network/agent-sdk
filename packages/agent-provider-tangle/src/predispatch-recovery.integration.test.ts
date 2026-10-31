import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import type { AgentExactRunControlRef } from "@tangle-network/agent-interface";
import type { AgentEnvironmentEgressPolicy } from "@tangle-network/agent-interface/environment-provider";
import { createTangleProvider } from "./index.js";
import { RETAINED_DEPLOYMENT_DOCUMENT } from "./retained-control-test-helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const profile = { name: "root", harness: "claude-code" as const };
const proof = { hostId: "fixture-host", containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, bundleRevision: "c".repeat(40), bundleChecksum: `sha256:${"d".repeat(64)}` };

/** A real SDK transport: credential preflight refuses before a backend is selected. */
type RefFault = "missing" | "environment" | "digest" | "execution-race" | "read-failure";
async function fixture(code: string, status = 503, lostReply = false, refFault?: RefFault, completed = false, egress?: AgentEnvironmentEgressPolicy) {
  const requests: string[] = [];
  const creates: Record<string, unknown>[] = [], dispatches: Record<string, unknown>[] = [];
  let admit = false, selected = false;
  let run: { executionId: string; sessionId: string; turnId: string; runControlRef: AgentExactRunControlRef } | undefined, statusReads = 0;
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
      response.end(JSON.stringify({ ...RETAINED_DEPLOYMENT_DOCUMENT, interactions: { responseDedupe: false }, nativeSessionCaptureVersion: 2, nativeSessionCaptureHarnesses: ["claude-code"] }));
    } else if (path.endsWith("/messages/turns")) {
      if (run && completed) response.end(JSON.stringify({ turnId: run.turnId, sessionId: run.sessionId, completedAt: new Date(0).toISOString(), result: { success: true, status: "success", executionId: run.executionId, durationMs: 1 } }));
      else { response.writeHead(204); response.end(); }
    } else if (run && path.endsWith(`/agents/sessions/${run.sessionId}`)) {
      statusReads++;
      if (refFault === "read-failure" && statusReads > 1) {
        response.writeHead(503); response.end(JSON.stringify({ code: "SERVER_ERROR", message: "status unavailable" })); return;
      }
      const ref = { ...run.runControlRef };
      if (refFault === "environment") ref.environmentId = "another-box";
      if (refFault === "digest") ref.requestDigest = `sha256:${"f".repeat(64)}`;
      if (refFault === "execution-race" && statusReads > 1) ref.executionId = "another-execution";
      response.end(JSON.stringify({ id: run.sessionId, status: completed ? "completed" : "running", activeExecutionId: run.executionId, latestExecutionId: ref.executionId, ...(refFault === "missing" ? {} : { runControlRef: ref }) }));
    } else if (path.endsWith("/agents/run/stream") && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const executionId = request.headers["x-execution-id"];
      if (typeof executionId !== "string" || executionId !== input.runControlRef?.executionId) throw new Error("SDK dispatch execution identity differs from its control reference");
      dispatches.push(input);
      if (lostReply && !run) run = { executionId, sessionId: input.sessionId, turnId: input.turnId, runControlRef: input.runControlRef };
      if (admit) {
        selected = true;
        response.setHeader("content-type", "text/event-stream");
        response.end(`event: execution.started\ndata: ${JSON.stringify({ executionId, sessionId: input.sessionId, runControlRef: input.runControlRef })}\n\n`);
      } else {
        response.writeHead(status);
        response.end(JSON.stringify({ status: "error", code, message: "Sandbox Hub credential is temporarily unavailable." }));
      }
    } else if (path.endsWith("/backend") && selected) {
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
  const environment = await provider.create({ profile, idempotencyKey: "runtime:fixture", ...(egress ? { egress } : {}) });
  return { provider, environment, requests, creates, dispatches, reconnect, allowDispatch: () => { admit = true; }, state: () => ({ run, statusReads }) };
}

it("forwards a strict allowlist with a private-range entry verbatim in the Sandbox create body", async () => {
  const allowDomains = ["api.github.com", { domain: "build.internal", allowPrivateIps: ["10.0.0.0/24", "fd00::/8"] }];
  const { creates } = await fixture("SERVER_ERROR", 503, false, undefined, false, { mode: "strict", allowDomains });
  expect(creates).toHaveLength(1);
  expect(creates[0]!.egressPolicy).toEqual({ mode: "strict", allowDomains });
});

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
  expect(requests.filter((request) => request.endsWith("/backend"))).toHaveLength(1);
  expect(reference.controlRef).toEqual(dispatches[0]!.runControlRef);
  expect(reference.metadata).toMatchObject({ dispatched: true });
});

it.each([["SERVER_ERROR", 503], ["HUB_CREDENTIAL_REFRESH_FAILED", 502]])("preserves the SDK's %s HTTP %s error", async (code, status) => {
  const { environment, requests } = await fixture(code, status);
  const error = await environment.dispatch!({ prompt: "research", turnId: "root:0", profile }).catch((error: unknown) => error);
  expect(error, JSON.stringify(requests)).toMatchObject({ status, code });
});

it.each([false, true])("recovers the authoritative reference after a lost reply (completed=%s)", async (completed) => {
  const { environment, reconnect, creates, dispatches, state } = await fixture("SERVER_ERROR", 503, true, undefined, completed);
  const turn = { prompt: "research", turnId: "root:0", profile };
  await expect(environment.dispatch!(turn)).rejects.toMatchObject({ status: 503 });
  const recovered = await reconnect().create({ profile, idempotencyKey: "runtime:fixture" });
  const reference = await recovered.dispatch!(turn);
  expect(reference.controlRef).toEqual(state().run!.runControlRef);
  expect(reference.metadata).toMatchObject({ dispatched: false, alreadyExisted: true });
  expect(creates).toHaveLength(2);
  expect(dispatches).toHaveLength(1);
  expect(state().run!.executionId).toBe(reference.controlRef!.executionId);
});

it.each(["missing", "environment", "digest", "execution-race", "read-failure"] as const)("retains the admitted execution when status authority is %s", async (fault) => {
  const { environment, reconnect, dispatches, state } = await fixture("SERVER_ERROR", 503, true, fault);
  const turn = { prompt: "research", turnId: "root:0", profile };
  await expect(environment.dispatch!(turn)).rejects.toMatchObject({ status: 503 });
  const recovered = await reconnect().create({ profile, idempotencyKey: "runtime:fixture" });
  await expect(recovered.dispatch!(turn)).rejects.toThrow(fault === "read-failure" ? /status unavailable/ : /exact.*control reference/);
  expect(dispatches).toHaveLength(1);
  expect(state().run).toBeDefined();
});
