import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import {
  AgentInteractiveSessionControlClaimSchema,
  AgentInteractiveSessionRefSchema,
  agentInteractiveSessionStopRequestDigest,
  canonicalCandidateDigest,
} from "@tangle-network/agent-interface";
import { createTangleProvider } from "./index.js";
import { RETAINED_DEPLOYMENT_DOCUMENT } from "./retained-control-test-helpers.js";
import { incarnationId, interactiveRun as run, preparationReceipt, startedAt } from "./interactive-test-helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

type Mode = "running" | "404" | "failed" | "deleted" | "503";

/** A Sandbox API peer whose answer for the box changes after the environment is held. */
async function peer() {
  const state: { mode: Mode } = { mode: "running" };
  let baseUrl = "";
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    response.setHeader("content-type", "application/json");
    const info = (status: string) => JSON.stringify({
      id: run.environmentId, status, createdAt: new Date(0).toISOString(),
      filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
      filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
      connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/${run.environmentId}/runtime`, authToken: "fixture-runtime-token", edgeStatus: "ready" },
    });
    if (state.mode === "404") { response.writeHead(404); response.end(JSON.stringify({ code: "NOT_FOUND", message: "sandbox not found" })); return; }
    if (state.mode === "503") { response.writeHead(503); response.end(JSON.stringify({ code: "SERVER_ERROR", message: "unavailable" })); return; }
    if (path === "/v1/backends") response.end(JSON.stringify({ backends: [], timestamp: new Date(0).toISOString() }));
    else if (path === `/v1/sandboxes/${run.environmentId}`) response.end(info(state.mode));
    else if (path.endsWith("/capabilities")) response.end(JSON.stringify(RETAINED_DEPLOYMENT_DOCUMENT));
    else { response.writeHead(404); response.end(JSON.stringify({ code: "NOT_FOUND", message: "unknown route" })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP fixture address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  // The published SDK's capability parser drops the interactive-agent block, so the instance
  // is told what the deployment serves; every other call is the real SDK over HTTP.
  const interactiveAgent = { start: true, status: true, attach: true, control: true, sendPrompt: true, stop: true };
  const provider = () => {
    const sdk = new Sandbox({ baseUrl, apiKey: "fixture-key" });
    const get = sdk.get.bind(sdk);
    sdk.get = async (...args) => {
      const box = await get(...args);
      if (box) box.capabilities = async () => ({ ...RETAINED_DEPLOYMENT_DOCUMENT, interactiveAgent });
      return box;
    };
    return createTangleProvider({ client: sdk });
  };
  const environment = await provider().get!(run.environmentId);
  if (!environment?.interactive) throw new Error("fixture environment exposes no interactive control ");
  const ref = AgentInteractiveSessionRefSchema.parse({ run, preparationReceipt, incarnationId, startedAt });
  const control = AgentInteractiveSessionControlClaimSchema.parse({
    refDigest: canonicalCandidateDigest(ref), generation: 1, leaseId: "lease-1", holderId: "holder-1", expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const material = { operationId: "stop-1", ref, control };
  const stop = { ...material, requestDigest: agentInteractiveSessionStopRequestDigest(material) };
  return { state, provider, interactive: environment.interactive(ref), stop };
}

it.each([["404", "deleted"], ["failed", "failed"], ["deleted", "deleted"]] as const)(
  "answers not_live for reconnect and stop when the Sandbox reports %s",
  async (mode, named) => {
    const { state, provider, interactive, stop } = await peer();
    state.mode = mode;
    await expect(provider().get!(run.environmentId)).resolves.toBeNull();
    await expect(interactive.stop(stop)).resolves.toMatchObject({
      status: "accepted", effect: "not_live", message: `sandbox ${named}`, operationId: "stop-1",
    });
  },
  30_000,
);

it("keeps a 503 as an error for reconnect and stop", async () => {
  const { state, provider, interactive, stop } = await peer();
  state.mode = "503";
  await expect(provider().get!(run.environmentId)).rejects.toThrow();
  await expect(interactive.stop(stop)).rejects.toThrow();
}, 60_000);
