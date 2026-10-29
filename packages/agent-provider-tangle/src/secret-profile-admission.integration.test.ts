import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import { AgentTurnResultSchema } from "@tangle-network/agent-interface";
import { createTangleProvider } from "./index.js";
import { RETAINED_DEPLOYMENT_DOCUMENT } from "./retained-control-test-helpers.js";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
const profile = { name: "exact-root", harness: "codex" as const,
  model: { provider: "openai", default: "fixture-model" },
  prompt: { systemPrompt: "Read the compiled commission and owned repository." },
  tools: { agent_runtime_coordination_knowledge_read: true } };
const firstBearer = "fixture-runtime-authority-first", nextBearer = "fixture-runtime-authority-rotated";

/** Only the peer/external native process is controlled; provider, published SDK and HTTP are real. */
async function fixture(fault?: "prepare-refused" | "invalid-receipt" | "active", cwd?: string, repoUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), "provider-secret-admission-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const volume = join(directory, "volume");
  const sessions = new Map<string, { backend: unknown; root: string }>();
  const prepared = new Map<string, { backend: Record<string, any>; digest: string; receipt: string }>();
  const runs = new Map<string, { sessionId: string; executionId: string; turnId: string; runControlRef: unknown; text: string }>();
  const requests: Array<{ path: string; body: Record<string, any> }> = [], errors: unknown[] = [];
  let root = "", baseUrl = "", creates = 0, nativeProcesses = 0, currentBearer = firstBearer;
  const proof = { hostId: "fixture-host", containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, bundleRevision: "c".repeat(40), bundleChecksum: `sha256:${"d".repeat(64)}` };
  const info = () => ({ id: "sandbox-secret", status: "running", createdAt: new Date(0).toISOString(),
    filesystemIncarnationId: "11111111-1111-4111-8111-111111111111", filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
    connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/sandbox-secret/runtime`, authToken: "fixture-runtime-key", edgeStatus: "ready" },
    captureProof: proof, createReceipt: { outcome: creates > 1 ? "idempotent_replay" : "created", idempotencyKeyApplied: true, captureProof: proof } });
  const sessionInfo = (id: string) => {
    const session = sessions.get(id), run = [...runs.values()].find(run => run.sessionId === id);
    return session && { id, status: run ? fault === "active" ? "running" : "completed" : "queued", backendType: "codex", createdAt: new Date(0).toISOString(),
      metadata: { backend: session.backend, workspacePath: session.root },
      ...(run ? { latestExecutionId: run.executionId, ...(fault === "active" ? { activeExecutionId: run.executionId } : {}), runControlRef: run.runControlRef } : {}) };
  };
  const server = createServer(async (request, response) => {
    const answer = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    try {
      const url = new URL(request.url!, "http://fixture");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/coordination") {
        expect(request.headers.authorization).toBe("Bearer " + currentBearer);
        return answer(200, { observation: "authenticated Runtime authority" });
      }
      if (url.pathname === "/v1/backends") return answer(200, { backends: [], timestamp: new Date(0).toISOString() });
      if (url.pathname === "/v1/sandboxes" && request.method === "POST") {
        creates++;
        expect(body.cwd).toBe(cwd ?? (repoUrl ? undefined : "workspace"));
        if (repoUrl) expect(body.git.url).toBe(repoUrl);
        root = join(volume, body.cwd ?? "checked-out-repo");
        await mkdir(join(root, "inputs"), { recursive: true });
        await mkdir(join(root, "repo"), { recursive: true });
        await writeFile(join(root, "inputs/commission.md"), "The compiled commission is already present.\n");
        await writeFile(join(root, "repo/source.rs"), "pub fn observed() {}\n");
        return answer(200, info());
      }
      if (url.pathname === "/v1/sandboxes/sandbox-secret") return answer(200, info());
      if (url.pathname.endsWith("/capabilities")) return answer(200, { ...RETAINED_DEPLOYMENT_DOCUMENT, interactions: {}, nativeSessionCaptureVersion: 2, nativeSessionCaptureHarnesses: ["codex"] });
      if (url.pathname.endsWith("/backend")) return answer(200, { type: "codex" });
      if (url.pathname.endsWith("/agents/sessions") && request.method === "POST") {
        expect(body.backend.metadata.profileSecretIsolation).toBe(true);
        expect(body.backend.runtimeSecrets).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain(firstBearer);
        expect(JSON.stringify(body)).not.toContain(nextBearer);
        expect(body.backend.profile).toEqual(profile);
        const prior = sessions.get(body.sessionId);
        if (prior) expect(prior.backend).toEqual(body.backend);
        else sessions.set(body.sessionId, { backend: body.backend, root });
        return answer(200, sessionInfo(body.sessionId));
      }
      const prepare = url.pathname.match(/\/agents\/sessions\/([^/]+)\/public-profile-revisions\/prepare$/);
      if (prepare) {
        const id = decodeURIComponent(prepare[1]!), session = sessions.get(id);
        expect(session?.root).toBe(root);
        expect(root).not.toBe(volume);
        expect(body.secret).toBe(true);
        expect(body.backend.metadata.profileSecretIsolation).toBe(true);
        expect(body.backend.profile).toEqual(profile);
        expect(body.backend.runtimeSecrets.AGENT_RUNTIME_COORDINATION_TOKEN).toBe(currentBearer);
        expect(body.expectedPublicProfileRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
        if (fault === "prepare-refused") return answer(400, { error: { code: "SECRET_PROFILE_PREPARATION_FAILED", message: "native preparation refused" } });
        const receipt = "hmac-sha256:" + createHmac("sha256", "fixture-executor-key").update(JSON.stringify({ id, backend: body.backend })).digest("hex");
        prepared.set(id, { backend: body.backend, digest: body.expectedPublicProfileRequestDigest, receipt });
        await writeFile(join(root, "prepared-public-profile.json"), JSON.stringify(body.backend.profile));
        return answer(200, { workspacePlanDigest: "sha256:" + "e".repeat(64), executorReceipt: fault === "invalid-receipt" ? "invalid" : receipt, conflicts: [] });
      }
      const sessionId = url.pathname.match(/\/agents\/sessions\/([^/]+)$/)?.[1];
      if (sessionId) return sessions.has(decodeURIComponent(sessionId)) ? answer(200, sessionInfo(decodeURIComponent(sessionId))) : answer(404, { code: "NOT_FOUND", message: "session absent" });
      if (url.pathname.endsWith("/messages/turns")) {
        const run = [...runs.values()].find(run => run.turnId === url.searchParams.get("turnId"));
        if (!run || fault === "active") { response.writeHead(204); response.end(); return; }
        return answer(200, { turnId: run.turnId, sessionId: run.sessionId, completedAt: new Date(0).toISOString(),
          result: { success: true, status: "success", executionId: run.executionId, response: run.text, durationMs: 1 } });
      }
      if (url.pathname.endsWith("/agents/run/stream")) {
        const session = sessions.get(body.sessionId), revision = prepared.get(body.sessionId);
        expect(revision).toBeDefined();
        expect((session?.backend as any)?.metadata?.profileSecretIsolation).toBe(true);
        expect(body.backend.metadata.profileSecretIsolation).toBe(true);
        expect(body.expectedPublicProfileRequestDigest).toBe(revision?.digest);
        expect(body.expectedSecretProfileReceipt).toBe(revision?.receipt);
        expect(body.backend).toEqual(revision?.backend);
        expect(body.backend.profile).toEqual(profile);
        expect(request.headers["x-execution-id"]).toBe(body.runControlRef?.executionId ?? body.executionId ?? request.headers["x-execution-id"]);
        const executionId = String(request.headers["x-execution-id"]);
        // The real process reads the ORIGINAL create.cwd tree, never a copied session tree.
        const native = await execute(process.execPath, ["--input-type=module", "-e", `
          import { readFile } from 'node:fs/promises';
          import assert from 'node:assert/strict';
          const commission = await readFile('inputs/commission.md', 'utf8');
          const source = await readFile('repo/source.rs', 'utf8');
          const profile = JSON.parse(await readFile('prepared-public-profile.json', 'utf8'));
          assert.match(commission, /compiled commission/); assert.match(source, /pub fn/);
          assert.equal(profile.model.default, 'fixture-model');
          assert.equal(profile.prompt.systemPrompt, 'Read the compiled commission and owned repository.');
          assert.equal(profile.tools.agent_runtime_coordination_knowledge_read, true);
          const response = await fetch(${JSON.stringify(baseUrl + "/coordination")}, { headers: { Authorization: 'Bearer ' + process.env.AGENT_RUNTIME_COORDINATION_TOKEN } });
          assert.equal(response.status, 200); assert.equal((await response.json()).observation, 'authenticated Runtime authority');
          process.stdout.write(JSON.stringify({ pid: process.pid, cwd: process.cwd(), text: source.trim() }));
        `], { cwd: session!.root, env: { PATH: process.env.PATH, AGENT_RUNTIME_COORDINATION_TOKEN: currentBearer } });
        const observation = JSON.parse(native.stdout);
        expect(observation.cwd).toBe(root);
        expect(observation.pid).not.toBe(process.pid);
        nativeProcesses++;
        const run = { sessionId: body.sessionId, executionId, turnId: body.turnId, runControlRef: body.runControlRef, text: observation.text };
        runs.set(executionId, run);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const started = `event: execution.started\ndata: ${JSON.stringify({ executionId, sessionId: body.sessionId, runControlRef: body.runControlRef })}\n\n`;
        // The active case withholds terminal delivery; only the admission is public.
        response.end(fault === "active" ? started : started + `event: result\ndata: ${JSON.stringify({ success: true, status: "success", executionId, response: run.text, durationMs: 1 })}\n\nevent: done\ndata: {"outcome":{"type":"completed"}}\n\n`);
        return;
      }
      return answer(404, { code: "NOT_FOUND", message: "unknown fixture route" });
    } catch (error) {
      errors.push(error);
      return answer(400, { error: { code: "BOUNDARY_ASSERTION", message: String(error) } });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new Sandbox({ apiKey: "fixture-api-key", baseUrl, directExec: false, trustLocalCliAuth: false });
  const provider = createTangleProvider({ client,
    modelCredentials: { apiKeyEnv: "FIXTURE_MODEL", baseUrl: "https://model.invalid" },
  });
  const environment = await provider.create({ profile, idempotencyKey: "secret-fixture", workspace: {
    ...(cwd ? { cwd: { base: "repository", path: cwd } } : {}), ...(repoUrl ? { repoUrl } : {}),
  } });
  const turn = (id: string) => ({ profile, prompt: "Read the owned commission and repository.", executionId: id, turnId: id,
    providerOptions: { backend: { type: "codex", runtimeSecrets: { AGENT_RUNTIME_COORDINATION_TOKEN: currentBearer },
      runtimeAttachments: { mcp: { "agent-runtime-coordination": { transport: "http", url: baseUrl + "/coordination",
        headers: { Authorization: { kind: "secret-ref", key: "AGENT_RUNTIME_COORDINATION_TOKEN", format: "bearer" } } } } } } } });
  return { environment, requests, errors, sessions, prepared, turn, rotate: () => { currentBearer = nextBearer; },
    count: () => nativeProcesses, creates: () => creates, root: () => root };
}

it.each([{ cwd: undefined, repoUrl: undefined }, { cwd: "authored-directory", repoUrl: undefined }, { cwd: undefined, repoUrl: "https://git.invalid/owner/checked-out-repo.git" }])("prepares exact secret stream, detached and session turns in the original cwd (%j)", async ({ cwd, repoUrl }) => {
  const f = await fixture(undefined, cwd, repoUrl), original = JSON.stringify(profile);
  const input = f.turn("detached-one"), originalInput = JSON.stringify(input);
  const reference = await f.environment.dispatch!(input);
  expect(f.count()).toBe(1);
  expect(reference.controlRef?.executionId).toBe("detached-one");
  const first = [...f.prepared.values()][0]!;
  f.rotate();
  const replayed = await f.environment.dispatch!(f.turn("detached-one"));
  expect(replayed.controlRef).toEqual(reference.controlRef);
  expect(replayed.metadata).toMatchObject({ dispatched: false, alreadyExisted: true });
  expect(f.count()).toBe(1);
  const rotated = [...f.prepared.values()][0]!;
  expect(rotated.digest).toBe(first.digest);
  expect(rotated.receipt).not.toBe(first.receipt);
  const priorRequests = f.requests.length;
  await expect(f.environment.dispatch!({ ...f.turn("detached-one"), controlRef: { ...reference.controlRef!, environmentId: "another-box" } }))
    .rejects.toThrow(/control reference does not match/);
  expect(f.requests.length).toBe(priorRequests);
  const events = [];
  for await (const event of f.environment.stream(f.turn("stream-one"))) events.push(event);
  expect(events.length).toBeGreaterThan(0);
  AgentTurnResultSchema.parse({ text: "The source was observed.", success: true, events });
  const session = f.environment.session!("session-one");
  const result = await session.prompt!(f.turn("session-one-turn"));
  expect(result.success, JSON.stringify(result)).toBe(true);
  AgentTurnResultSchema.parse(result);
  expect(f.count()).toBe(3);
  expect(f.creates()).toBe(1);
  expect(new Set([...f.sessions.values()].map(session => session.root))).toEqual(new Set([f.root()]));
  expect(JSON.stringify([...f.sessions.values()])).not.toMatch(/fixture-runtime-authority/);
  expect(JSON.stringify(profile)).toBe(original);
  expect(JSON.stringify(input)).toBe(originalInput);
  expect(await readFile(join(f.root(), "inputs/commission.md"), "utf8")).toContain("already present");
  expect(f.errors).toEqual([]);
});

it.each(["prepare-refused", "invalid-receipt"] as const)("refuses %s before any native execution", async fault => {
  const f = await fixture(fault);
  await expect(f.environment.dispatch!(f.turn("never-admitted"))).rejects.toThrow(/native preparation refused|invalid receipt/);
  expect(f.count()).toBe(0);
  expect(f.requests.some(request => request.path.endsWith("/agents/run/stream"))).toBe(false);
  expect(f.creates()).toBe(1);
  expect(f.errors).toEqual([]);
});

it("reprepares rotated authority but reuses the exact active admission without another native turn", async () => {
  const f = await fixture("active");
  const first = await f.environment.dispatch!(f.turn("still-active"));
  f.rotate();
  const replayed = await f.environment.dispatch!(f.turn("still-active"));
  expect(replayed.controlRef).toEqual(first.controlRef);
  expect(replayed.metadata).toMatchObject({ dispatched: false, alreadyExisted: true });
  expect(f.count()).toBe(1);
  expect(f.requests.filter(request => request.path.endsWith("/public-profile-revisions/prepare"))).toHaveLength(2);
  expect(f.requests.filter(request => request.path.endsWith("/agents/run/stream"))).toHaveLength(1);
  expect(f.creates()).toBe(1);
  expect(f.errors).toEqual([]);
});
