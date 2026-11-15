import { createServer } from "node:http";
import { Sandbox } from "@tangle-network/sandbox";
import { canonicalCandidateDigest, workspaceCheckpointRequestDigest, workspaceCleanupRequestDigest } from "@tangle-network/agent-interface";
import { afterEach, expect, it } from "vitest";
import { createTangleProvider } from "./index.js";
import { checkpointMarkerTags } from "./tangle-workspace-markers.js";

const sourceId = "sandbox-seal-source";
const hex = (label: string) => canonicalCandidateDigest({ label }).slice("sha256:".length);
const checkpointRequest = (environmentId: string, idempotencyKey: string) => {
  const material = { source: { runId: "run-seal", provider: "tangle-sandbox", environmentId, sessionId: "session-seal", executionId: "execution-seal", requestDigest: canonicalCandidateDigest({ request: "seal" }) } };
  return { ...material, idempotencyKey, requestDigest: workspaceCheckpointRequestDigest(material) };
};
const cleanupRequest = (targetId: string, operationId: string) => {
  const material = { kind: "checkpoint" as const, targetId, provider: "tangle-sandbox" };
  return { ...material, operationId, requestDigest: workspaceCleanupRequestDigest(material) };
};
const servers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((close) => close())); });

/**
 * Sandbox's seal behavior over HTTP, read through the real SDK: a checkpoint is acknowledged under one id,
 * listed under its physical id with that id in one `seal.<id>` tag, and deleted by the id the row lists.
 */
async function sealingSandbox() {
  const rows: { id: string; sandboxId: string; createdAt: string; tags: string[] }[] = [];
  const operations = new Map<string, { snapshotId: string; createdAt: string; tags: string[] }>();
  const deletes: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const base = `/v1/sandboxes/${sourceId}`;
    response.setHeader("content-type", "application/json");
    if (url.pathname === base && request.method === "GET") {
      response.end(JSON.stringify({ id: sourceId, status: "running", createdAt: new Date(0).toISOString(), filesystemIncarnationId: "22222222-2222-4222-8222-222222222222", filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready" }));
    } else if (url.pathname === `${base}/snapshots` && request.method === "POST") {
      const key = String(request.headers["idempotency-key"]);
      const createdAt = new Date(1_000).toISOString();
      const acknowledged = hex(`ack:${key}`);
      rows.push({ id: hex(`physical:${key}`), sandboxId: sourceId, createdAt, tags: [...body.tags, `seal.${acknowledged}`] });
      operations.set(key, { snapshotId: acknowledged, createdAt, tags: body.tags });
      response.end(JSON.stringify({ snapshotId: acknowledged, createdAt, tags: body.tags, idempotency: { outcome: "created", requestDigest: canonicalCandidateDigest(body.tags) } }));
    } else if (url.pathname === `${base}/snapshots` && request.method === "GET") {
      response.end(JSON.stringify({ snapshots: rows }));
    } else if (url.pathname === `${base}/workspace-operations/lookup`) {
      const result = operations.get(body.idempotencyKey);
      response.end(JSON.stringify(result ? { outcome: "found", kind: "checkpoint", state: "succeeded", result } : { outcome: "not_found", kind: "checkpoint" }));
    } else if (url.pathname.startsWith(`${base}/snapshots/`) && request.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice(`${base}/snapshots/`.length));
      deletes.push(id);
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
      response.end(JSON.stringify({ outcome: index >= 0 ? "deleted" : "already_absent" }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ code: "NOT_FOUND", message: `${request.method} ${url.pathname}` }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP fixture address");
  const provider = createTangleProvider({ client: new Sandbox({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "fixture-key" }) });
  const open = async () => {
    const branching = await provider.workspaceBranching!.forEnvironment(sourceId);
    if (!branching) throw new Error("source has no workspace branching capability");
    return branching;
  };
  return { rows, deletes, open };
}

it("deletes a sealed checkpoint by its physical id after a restart, and inventory no longer lists it", async () => {
  const sandbox = await sealingSandbox();
  const created = await (await sandbox.open()).checkpoint(checkpointRequest(sourceId, "seal-checkpoint"));
  if (created.status !== "created") throw new Error(`checkpoint setup failed: ${JSON.stringify(created)}`);
  const [physical] = sandbox.rows;
  expect(physical.id).not.toBe(created.checkpoint.checkpointId);
  expect(physical.tags).toContain(`seal.${created.checkpoint.checkpointId}`);

  // A fresh handle holds no in-process record, as Runtime's cleanup after settlement does.
  const cleanup = cleanupRequest(created.checkpoint.checkpointId, "cleanup-seal-checkpoint");
  expect(await (await sandbox.open()).deleteCheckpoint(cleanup)).toMatchObject({ status: "deleted" });
  expect(sandbox.deletes).toEqual([physical.id]);
  expect(sandbox.rows).toEqual([]);
  expect(await (await sandbox.open()).deleteCheckpoint({ ...cleanup, operationId: "cleanup-seal-checkpoint-again" })).toMatchObject({ status: "already_absent" });
  expect(sandbox.deletes).toEqual([physical.id]);
});

it.each([
  ["foreign markers", "not marked by this source", () => [checkpointMarkerTags(checkpointRequest("sandbox-another-source", "foreign-checkpoint"))]],
  ["no markers", "not marked by this source", () => [[]]],
  ["two seal witnesses", "ambiguous seal alias", () => [checkpointMarkerTags(checkpointRequest(sourceId, "twin-a")), checkpointMarkerTags(checkpointRequest(sourceId, "twin-b"))]],
] as const)("refuses a seal alias with %s and sends no delete", async (_case, reason, markers) => {
  const sandbox = await sealingSandbox();
  const alias = hex("alias-under-test");
  markers().forEach((tags, index) => sandbox.rows.push({ id: hex(`row-${index}`), sandboxId: sourceId, createdAt: new Date(1_000).toISOString(), tags: [...tags, `seal.${alias}`] }));
  const acknowledgement = await (await sandbox.open()).deleteCheckpoint(cleanupRequest(alias, "cleanup-refused-alias"));
  expect(acknowledgement).toMatchObject({ status: "unknown", retryable: true, message: `Sandbox checkpoint lookup answered unknown (${reason}); deletion was not attempted` });
  expect(sandbox.deletes).toEqual([]);
  expect(sandbox.rows).toHaveLength(markers().length);
});
