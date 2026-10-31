import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import { ProxySecretReceiptSchema, type ProxySecretBinding } from "@tangle-network/agent-interface";
import { createTangleProvider } from "./index.js";
import { RETAINED_DEPLOYMENT_DOCUMENT } from "./retained-control-test-helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
const declarations: ProxySecretBinding[] = [
  { envName: "NATIVE_ALIAS", secretRef: { kind: "secret-ref", key: "NATIVE_BUNDLE" }, hosts: ["native.example.com"], presentation: { type: "bearer" } },
  { envName: "GENERIC_ALIAS", secretRef: { kind: "secret-ref", key: "GENERIC_SOURCE" }, hosts: ["generic.example.com"], presentation: { type: "bearer" } },
];
const publicRevision = { workspacePlanDigest: `sha256:${"a".repeat(64)}`, materializedDigest: `sha256:${"b".repeat(64)}`, launchDigest: "c".repeat(64) };
const privateReceipt = `hmac-sha256:${"d".repeat(64)}`;
type Fault = "missing" | "malformed" | "wrong-box" | "pending" | "generation" | "grant" | "expiry" | "scope" | "subset" | "subset-generation" | "metadata" | "partial-group";

/** Real public provider and SDK against an authenticated HTTP peer; no proxy/HOME enforcement claim. */
async function fixture(options: { fault?: Fault; canonical?: boolean; native?: boolean; secret?: boolean; empty?: boolean; twoNativeAliases?: boolean; refusePrepare?: "disabled" | "failed" } = {}) {
  const { fault, canonical = true, native = true, secret = false, empty = false, twoNativeAliases = false, refusePrepare } = options;
  const declared = twoNativeAliases
    ? [declarations[0]!, { ...declarations[0]!, envName: "NATIVE_ID_ALIAS" }, declarations[1]!]
    : declarations;
  const now = Date.now(), sessions = new Set<string>();
  const bindings = declared.map((binding, i) => ({ envName: binding.envName, secretRef: binding.secretRef, grant: {
    protocolVersion: 1, grantId: `grant-${i}`, sandboxId: "sandbox-phase", epoch: "phase-epoch",
    identity: { tenantId: "fixture-owner", issuerId: "fixture-issuer", secretId: binding.secretRef.key === "NATIVE_BUNDLE" ? "native-source" : "generic-source", revision: "revision-1" },
    scope: { hosts: binding.hosts }, presentation: binding.presentation, placeholderFormat: "opaque",
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  } }));
  const full = (installed: boolean) => ProxySecretReceiptSchema.parse({ protocolVersion: 1, sandboxId: "sandbox-phase", generation: 1,
    status: installed ? "installed" : "proxy-installed", proxyAcknowledged: true, materializationAcknowledged: installed, bindings });
  let baseUrl = "", prepared = false, faultsArmed = false, runs = 0, currentReads = 0, staleReads = 0, refusals = 0;
  let pausePreparation = false, holdInfo = false, releaseInfo = () => {}, releasePreparation = () => {}, startedPreparation = () => {};
  const preparationStarted = new Promise<void>(resolve => { startedPreparation = resolve; });
  let startedHeldRead = () => {}, observedPostAckRefresh = () => {};
  const heldReadStarted = new Promise<void>(resolve => { startedHeldRead = resolve; });
  const postAckRefresh = new Promise<void>(resolve => { observedPostAckRefresh = resolve; });
  const paths: string[] = [], errors: unknown[] = [], preparedBodies: Record<string, unknown>[] = [];
  const current = () => {
    const currentFault = faultsArmed ? fault : undefined;
    if (!canonical || empty || currentFault === "missing" || currentFault === "metadata") return undefined;
    if (currentFault === "malformed") return { ...full(false), generation: "not-a-generation" };
    const receipt = full((prepared || !native) && currentFault !== "pending");
    if (currentFault === "wrong-box") return { ...receipt, sandboxId: "sandbox-other", bindings: bindings.map(b => ({ ...b, grant: { ...b.grant, sandboxId: "sandbox-other" } })) };
    if (currentFault === "expiry") return { ...receipt, bindings: bindings.map(b => ({ ...b, grant: { ...b.grant, issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now - 1).toISOString() } })) };
    if (currentFault === "scope") return { ...receipt, bindings: bindings.map(b => ({ ...b, grant: { ...b.grant, scope: { hosts: ["other.example.com"] } } })) };
    if (prepared && currentFault === "generation") return { ...receipt, generation: 2 };
    if (prepared && currentFault === "grant") return { ...receipt, bindings: bindings.map(b => ({ ...b, grant: { ...b.grant, grantId: b.grant.grantId + "-changed" } })) };
    return receipt;
  };
  const info = () => ({ id: "sandbox-phase", status: "running", createdAt: new Date(0).toISOString(),
    filesystemIncarnationId: "11111111-1111-4111-8111-111111111111", filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
    connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/sandbox-phase/runtime`, authToken: "fixture-runtime-key", edgeStatus: "ready" },
    metadata: fault === "metadata" ? { tangleProxySecrets: declared, proxySecretReceipt: full(true) } : {},
    proxySecretReceipt: current(), createReceipt: { outcome: "created", idempotencyKeyApplied: true } });
  const sessionInfo = (id: string) => ({ id, status: "queued", backendType: "codex", createdAt: new Date(0).toISOString() });
  const server = createServer(async (request, response) => {
    const answer = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    try {
      expect(request.headers.authorization).toBeTruthy();
      const url = new URL(request.url!, "http://fixture"), chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      paths.push(url.pathname);
      if (url.pathname === "/v1/backends") return answer(200, { backends: [], timestamp: new Date(0).toISOString() });
      if (url.pathname === "/v1/sandboxes" && request.method === "POST") return answer(200, info());
      if (url.pathname === "/v1/sandboxes/sandbox-phase") {
        const snapshot = info();
        if (prepared || !native || refusePrepare) currentReads++;
        else staleReads++;
        if (holdInfo && !prepared) { startedHeldRead(); await new Promise<void>(resolve => { releaseInfo = resolve; }); }
        return answer(200, snapshot);
      }
      if (url.pathname.endsWith("/capabilities")) return answer(200, { ...RETAINED_DEPLOYMENT_DOCUMENT, interactions: { responseDedupe: false }, cliAuthReferences: true });
      if (url.pathname.endsWith("/backend")) return answer(200, { type: "codex" });
      if (url.pathname.endsWith("/agents/sessions") && request.method === "POST") {
        sessions.add(body.sessionId);
        expect(body.backend.runtimeSecrets).toBeUndefined();
        expect(body.backend.metadata?.profileSecretIsolation === true).toBe(secret);
        return answer(200, sessionInfo(body.sessionId));
      }
      const preparation = url.pathname.match(/\/agents\/sessions\/([^/]+)\/public-profile-revisions\/prepare$/);
      if (preparation) {
        expect(sessions.has(decodeURIComponent(preparation[1]!))).toBe(true);
        expect(body.secret === true).toBe(secret);
        expect(body.expectedPublicProfileRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
        if (refusePrepare) {
          // The sidecar's own refusal, as served when no public revision root is configured.
          refusals++;
          return answer(409, { success: false, error: { code: "PUBLIC_PROFILE_PREPARATION_FAILED",
            message: refusePrepare === "disabled" ? "Concurrent public profile materialization is disabled" : "Concurrent public profile preparation produced no native plan" } });
        }
        preparedBodies.push(body); startedPreparation();
        if (pausePreparation) await new Promise<void>(resolve => { releasePreparation = resolve; });
        prepared = true;
        const group = bindings.filter(binding => binding.secretRef.key === "NATIVE_BUNDLE");
        const subset = { ...full(true), bindings: fault === "partial-group" ? group.slice(0, 1) : group, ...(fault === "subset-generation" ? { generation: 2 } : {}) };
        if (fault === "subset") subset.bindings = bindings.filter(binding => binding.secretRef.key !== "NATIVE_BUNDLE");
        return answer(200, { ...publicRevision, ...(secret ? { executorReceipt: privateReceipt } : {}), conflicts: [],
          ...(canonical && native ? { proxySecretReceipt: subset } : {}) });
      }
      const session = url.pathname.match(/\/agents\/sessions\/([^/]+)$/);
      if (session) return answer(200, sessionInfo(decodeURIComponent(session[1]!)));
      if (url.pathname.endsWith("/messages/turns")) { response.writeHead(204); response.end(); return; }
      const replay = url.pathname.match(/\/agents\/run\/([^/]+)\/events$/);
      if (replay) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`event: result\ndata: ${JSON.stringify({ success: true, status: "success", executionId: replay[1], sessionId: "prior-session", response: "existing result" })}\n\nevent: done\ndata: {"outcome":{"type":"completed"}}\n\n`);
        return;
      }
      if (url.pathname.endsWith("/agents/run/stream")) {
        if (canonical && !empty) { if (secret || (native && !refusePrepare)) expect(prepared).toBe(true); expect(currentReads).toBeGreaterThan(0); }
        if (secret) expect(body.expectedSecretProfileReceipt).toBe(privateReceipt);
        else if (canonical && !empty && native && !refusePrepare) expect(body.expectedPublicProfileRevision).toEqual(publicRevision);
        if (refusePrepare) { expect(body.expectedPublicProfileRevision).toBeUndefined(); expect(body.expectedPublicProfileRequestDigest).toBeUndefined(); }
        if (preparedBodies.length) expect(body.expectedPublicProfileRequestDigest).toBe(preparedBodies.at(-1)!.expectedPublicProfileRequestDigest);
        runs++;
        const executionId = String(request.headers["x-execution-id"]);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`event: execution.started\ndata: ${JSON.stringify({ executionId, sessionId: body.sessionId, runControlRef: body.runControlRef })}\n\nevent: result\ndata: ${JSON.stringify({ success: true, status: "success", executionId, response: "prepared", durationMs: 1 })}\n\nevent: done\ndata: {"outcome":{"type":"completed"}}\n\n`);
        return;
      }
      return answer(404, { code: "NOT_FOUND", message: "unknown fixture route" });
    } catch (error) { errors.push(error); return answer(400, { error: { code: "BOUNDARY_ASSERTION", message: "fixture boundary rejected" } }); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw Error("missing fixture address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  // Observe the real public refresh call; arguments, receiver, result and HTTP remain unchanged.
  class ObservedSandbox extends Sandbox {
    override async create(...args: Parameters<Sandbox["create"]>) {
      const box = await super.create(...args);
      return new Proxy(box, { get(target, key) {
        const member = Reflect.get(target, key, target);
        if (key === "refresh") return (...refreshArgs: Parameters<typeof box.refresh>) => {
          if (prepared) observedPostAckRefresh();
          return member.apply(target, refreshArgs);
        };
        return typeof member === "function" ? member.bind(target) : member;
      } });
    }
  }
  const client = new ObservedSandbox({ apiKey: "fixture-api-key", baseUrl, directExec: false, trustLocalCliAuth: false });
  const profile = { name: "phase-profile", harness: "codex" as const,
    ...(native ? { model: { metadata: { credentialSource: "subscription" } } } : {}), ...(canonical ? { proxySecrets: empty ? [] : declared } : {}) };
  const provider = createTangleProvider({ client, modelCredentials: native ? { cliAuth: { account: "fixture-account", secretEnv: "NATIVE_BUNDLE", format: "bundle" as const } } : { apiKeyEnv: "FIXTURE_MODEL", baseUrl: "https://model.invalid" } });
  const environment = await provider.create({ profile });
  faultsArmed = true;
  const turn = (id: string) => ({ profile, prompt: "Return prepared", executionId: id, turnId: id,
    ...(secret ? { providerOptions: { backend: { type: "codex", runtimeSecrets: { TURN_TOKEN: "fixture-turn-only" } } } } : {}) });
  return { environment, turn, paths, errors, preparedBodies, refusals: () => refusals, count: () => runs, reads: () => ({ currentReads, staleReads }),
    pause: () => { pausePreparation = true; }, preparationStarted, heldReadStarted, postAckRefresh, hold: () => { holdInfo = true; },
    release: () => { releasePreparation(); }, releaseRead: () => { holdInfo = false; releaseInfo(); } };
}

it.each([false, true])("fences all three real prompt paths after full installed ACK (secret=%s)", async secret => {
  const f = await fixture({ secret });
  await f.environment.dispatch!(f.turn("detached"));
  for await (const _event of f.environment.stream(f.turn("streamed"))) { /* consume public events */ }
  const result = await f.environment.session!("session-one").prompt!(f.turn("session-turn"));
  expect(result.success).toBe(true); expect(f.count()).toBe(3);
  expect(f.environment.proxySecretReceipt?.status).toBe("installed");
  expect(f.environment.proxySecretReceipt?.bindings).toHaveLength(2);
  expect(f.preparedBodies).toHaveLength(3); expect(f.errors).toEqual([]);
});

it.each(["missing", "malformed", "wrong-box", "pending", "generation", "grant", "expiry", "scope", "subset", "subset-generation", "metadata"] as const)("refuses %s before dispatch HTTP", async fault => {
  const f = await fixture({ fault });
  const postAckErrors: Partial<Record<Fault, RegExp>> = {
    pending: /current matching installed proxy receipt/,
    generation: /custody changed during profile preparation/,
    grant: /custody changed during profile preparation/,
    subset: /HOME acknowledgement does not match current custody/,
    "subset-generation": /HOME acknowledgement does not match current custody/,
  };
  await expect(f.environment.dispatch!(f.turn("refused"))).rejects.toThrow(postAckErrors[fault]);
  if (postAckErrors[fault]) expect(f.preparedBodies).toHaveLength(1);
  expect(f.count()).toBe(0); expect(f.paths.some(path => path.endsWith("/agents/run/stream"))).toBe(false);
  expect(f.errors).toEqual([]);
});

it.each([false, true])("keeps prior no-policy callers accepted without receipts (secret=%s)", async secret => {
  const f = await fixture({ canonical: false, native: false, secret });
  await f.environment.dispatch!(f.turn("legacy"));
  expect(f.count()).toBe(1); expect(f.environment.proxySecretReceipt).toBeUndefined(); expect(f.errors).toEqual([]);
});

it("joins a pre-ACK refresh then starts a genuinely post-ACK receipt read", async () => {
  const f = await fixture(); f.pause();
  const dispatched = f.environment.dispatch!(f.turn("refresh-barrier"));
  await Promise.race([f.preparationStarted, dispatched]);
  f.hold(); const earlierRead = f.environment.status();
  await f.heldReadStarted;
  f.release(); await f.postAckRefresh;
  f.releaseRead(); await earlierRead; await dispatched;
  expect(f.reads().currentReads).toBeGreaterThan(0);
  expect(f.environment.proxySecretReceipt?.status).toBe("installed");
  expect(f.count()).toBe(1); expect(f.errors).toEqual([]);
});

it("keeps an explicit empty policy accepted without an installation receipt", async () => {
  const f = await fixture({ native: false, empty: true });
  await f.environment.dispatch!(f.turn("empty"));
  expect(f.count()).toBe(1); expect(f.environment.proxySecretReceipt).toBeUndefined();
  expect(f.preparedBodies).toEqual([]); expect(f.errors).toEqual([]);
});


it("launches an already installed generic policy without native preparation", async () => {
  const f = await fixture({ native: false });
  await f.environment.dispatch!(f.turn("generic"));
  expect(f.environment.proxySecretReceipt?.status).toBe("installed");
  expect(f.count()).toBe(1); expect(f.preparedBodies).toEqual([]); expect(f.errors).toEqual([]);
});

it("reads an exact existing execution without requiring new installation metadata", async () => {
  const f = await fixture({ native: false, fault: "missing" });
  const events = [];
  for await (const event of f.environment.stream({ sessionId: "prior-session", executionId: "prior-execution", lastEventId: "0" })) events.push(event);
  expect(events.length).toBeGreaterThan(0); expect(f.count()).toBe(0);
  expect(f.paths.some(path => path.endsWith("/prior-execution/events"))).toBe(true);
  expect(f.preparedBodies).toEqual([]); expect(f.errors).toEqual([]);
});

it.each([false, true])("requires the complete two-alias native group, apart from generic grants (secret=%s)", async secret => {
  const refused = await fixture({ secret, twoNativeAliases: true, fault: "partial-group" });
  await expect(refused.environment.dispatch!(refused.turn("one-native-ack"))).rejects.toThrow(/HOME acknowledgement/);
  expect(refused.count()).toBe(0);
  expect(refused.paths.some(path => path.endsWith("/agents/run/stream"))).toBe(false);
  expect(refused.errors).toEqual([]);
  const complete = await fixture({ secret, twoNativeAliases: true });
  await complete.environment.dispatch!(complete.turn("two-native-acks"));
  expect(complete.count()).toBe(1); expect(complete.errors).toEqual([]);
  expect(complete.environment.proxySecretReceipt?.bindings).toHaveLength(3);
  expect(complete.environment.proxySecretReceipt?.bindings.filter(binding => binding.secretRef.key === "NATIVE_BUNDLE")).toHaveLength(2);
});

it("launches native canonical turns unprepared when the sidecar serves no public revision root", async () => {
  const f = await fixture({ refusePrepare: "disabled" });
  await f.environment.dispatch!(f.turn("detached"));
  for await (const _event of f.environment.stream(f.turn("streamed"))) { /* consume public events */ }
  expect(f.count()).toBe(2); expect(f.refusals()).toBe(2); expect(f.preparedBodies).toEqual([]); expect(f.errors).toEqual([]);
});

it("still fails a native canonical turn when preparation fails for another reason", async () => {
  const f = await fixture({ refusePrepare: "failed" });
  await expect(f.environment.dispatch!(f.turn("refused"))).rejects.toThrow(/produced no native plan/);
  expect(f.count()).toBe(0); expect(f.paths.some(path => path.endsWith("/agents/run/stream"))).toBe(false); expect(f.errors).toEqual([]);
});
