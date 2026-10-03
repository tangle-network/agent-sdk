import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentExactRunControlRef } from "@tangle-network/agent-interface";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxInstanceLike, TangleRawEvidenceLike } from "./tangle-types.js";
import { bindTangleEvidenceEnvironment, captureTangleEnvironmentEvidence, captureTangleSandboxEvidence, captureTangleEnvironmentEvidenceToDirectory, noteTangleSession } from "./tangle-evidence.js";

const fixtureBoxes = new WeakMap<AgentEnvironment, SandboxInstanceLike>();
const fixtureRawResponses = new WeakMap<AgentEnvironment, TangleRawEvidenceLike>();

async function directoryExportFixture(environment: AgentEnvironment, options: {
  corrupt?: "payload" | "records" | "manifest" | "truncated" | "identity";
  afterExport?: () => void;
} = {}) {
  const { box, originalSession, source } = await readFixtureSource(environment);
  let exportDirectory: string | undefined;
  box.session = (id) => ({ ...originalSession(id),
    async rawEvidence() { throw new Error("The aggregate native route must not be called"); },
    async exportRawEvidence(destination) {
      exportDirectory = destination;
      await mkdir(destination, { mode: 0o700 });
      let index = 0;
      const retain = async (bytes: Buffer) => {
        const path = `payload-${index++}`;
        const ref = { path, sizeBytes: bytes.length, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
        await writeFile(join(destination, path), bytes, { mode: 0o600 });
        return ref;
      };
      const content = async (entry: { contentBase64?: string }) => {
        const { contentBase64, ...metadata } = entry;
        return contentBase64 === undefined ? metadata : { ...metadata, content: await retain(Buffer.from(contentBase64, "base64")) };
      };
      const ndjson = async (entries: unknown[]) => ({ ...await retain(Buffer.from(entries.map(entry => JSON.stringify(entry) + "\n").join(""))), format: "ndjson", records: entries.length });
      const files = await Promise.all(source.files.map(content));
      const processSources = await Promise.all(source.processSources.map(content));
      const processIo = await ndjson(await Promise.all(source.processIo.map(content)));
      const processTerminals = await ndjson(source.processTerminals);
      const events = await Promise.all(source.events.map(async (value) => {
        const event = value as { metadata: unknown; frames: unknown[] };
        return { metadata: event.metadata, frames: await ndjson(event.frames) };
      }));
      const manifest = { schema: "tangle.raw-evidence-archive.v1", ...source, files, processSources, processIo, processTerminals, events };
      if (options.corrupt === "identity") manifest.sessionId = "unrelated-session";
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const manifestRef = await retain(manifestBytes);
      if (options.corrupt === "payload") await writeFile(join(destination, "payload-0"), Buffer.alloc(source.files[0]!.sizeBytes, 9));
      if (options.corrupt === "records") await writeFile(join(destination, processIo.path), Buffer.alloc(processIo.sizeBytes, 32));
      if (options.corrupt === "truncated") await writeFile(join(destination, events[0]!.frames.path), "");
      if (options.corrupt === "manifest") await writeFile(join(destination, manifestRef.path), Buffer.alloc(manifestBytes.length, 32));
      options.afterExport?.();
      return { status: source.status, sessionId: id, directory: destination, manifestPath: join(destination, manifestRef.path),
        manifestSha256: manifestRef.sha256, manifest, coverageComplete: source.coverageComplete, missingReasons: source.missingReasons };
    },
  });
  return { source, originalSession, exportedDirectory: () => exportDirectory };
}

function spoolSource(sourceId: string, records: readonly unknown[]) {
  const bytes = Buffer.from(records.map((record) => JSON.stringify(record) + "\n").join(""));
  return { sourceId, contentBase64: bytes.toString("base64"), sizeBytes: bytes.byteLength,
    sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
}

function fixture(overrides: { complete?: boolean; filePath?: string; readError?: boolean; native?: boolean; wrongDigest?: boolean; wrongBackend?: boolean; missingBundleRevision?: boolean; incomplete?: boolean; workerRoot?: string; missingTerminal?: boolean; badSequence?: boolean;
  badInventory?: boolean; excludedCredential?: boolean; proof?: boolean; wrongProof?: boolean; partial?: boolean; wrongAttempt?: boolean; wrongProcessAttempt?: boolean; noProcess?: boolean; liveCountRace?: boolean } = {}) {
  const environment = { id: "box-1", provider: "tangle-sandbox" } as AgentEnvironment;
  const root = overrides.workerRoot ?? ".";
  const filePath = overrides.filePath ?? (root === "." ? "notes/.finding.json" : root + "/notes/.finding.json");
  const content = Buffer.from([0, 1, 255]);
  const proof = { hostId: "host-1", containerId: "c".repeat(64), imageId: "sha256:" + "a".repeat(64), bundleRevision: "b".repeat(40), bundleChecksum: "sha256:" + "d".repeat(64) };
  const box = {
    id: "box-1",
    ...(overrides.proof ? { captureProof: () => proof, createReceipt: () => ({ outcome: "created", idempotencyKeyApplied: true, captureProof: proof }) } : {}),
    fs: {
      async usage() { return { sizeBytes: 3, fileCount: 1, directoryCount: 1, complete: overrides.complete ?? true, skippedEntries: 0 }; },
      async list(path: string) {
        return path === root
          ? [{ name: "notes", path: root === "." ? "notes" : root + "/notes", size: 0, isDir: true, isFile: false, isSymlink: false, permissions: 0o755 }]
          : [{ name: ".finding.json", path: filePath, size: 3, isDir: false, isFile: true, isSymlink: false, permissions: 0o644 }];
      },
      async readBatch(paths: string[]) {
        return overrides.readError
          ? { files: [], errors: [{ path: paths[0], error: "unavailable" }] }
          : { files: [{ path: paths[0], content: content.toString("base64"), encoding: "base64" as const, size: 3 }], errors: [] };
      },
    },
    session(id: string) {
      return {
        id,
        async status() { return { id, status: "completed" }; },
        async *events() { yield { id: "1", type: "execution.completed", data: { executionId: "exec-1" } }; },
        async messages() { return [{ id: "message-1" }]; },
        ...(overrides.native ? { async rawEvidence() {
          const native = Buffer.from('{"session":"native-1"}');
          const stdout = Buffer.from("native output\n");
          const damagedSpool = Buffer.from('{"unfinished":');
          const response: TangleRawEvidenceLike = {
            status: overrides.partial ? "partial" as const : "captured" as const,
            sessionId: id,
            backendType: overrides.wrongBackend ? "codex" : "opencode",
            ...(overrides.proof ? { proofStatus: "verified" as const, containerId: overrides.wrongProof ? "e".repeat(64) : proof.containerId, sidecarBundleChecksum: proof.bundleChecksum } : {}),
            sidecarImageDigest: "sha256:" + "a".repeat(64),
            sidecarBundleRevision: overrides.missingBundleRevision ? "" : "b".repeat(40),
            nativeSessionId: "native-1",
            evidenceSources: [{ executionId: "exec-1", sourceId: "source-1", backendType: "opencode",
              runtimeHome: "/home/agent/session-home", credentialPaths: [".config/auth.json"] }],
            attempts: [{ executionId: overrides.wrongAttempt ? "unrelated-exec" : "exec-1", ordinal: 1,
              providerSessionId: "provider-1", nativeSessionIds: ["native-1"], processIds: overrides.noProcess ? [] : ["process-1"],
              outcome: "succeeded" as const, missingReasons: [] }],
            nativeRoots: [{ sourceId: "source-1", rootScope: "session-home" as const, path: "/home/agent/session-home" }],
            inventory: {
              scannedFiles: overrides.excludedCredential ? 2 : 1,
              reportedFiles: overrides.badInventory ? 2 : 1,
              excludedFiles: overrides.excludedCredential ? 1 : 0,
              scannedDirectories: 0, reportedDirectories: 0, excludedDirectories: 0,
              scannedSymlinks: 0, reportedSymlinks: 0, excludedSymlinks: 0, skippedEntries: 0 as const,
            },
            files: [{ sourceId: "source-1", rootScope: "session-home" as const, path: ".local/share/session.json", kind: "file" as const, mode: 0o600,
              uid: 1000, gid: 1000, mtimeMs: 1, ctimeMs: 1, sizeBytes: native.byteLength, sha256: "sha256:" + (overrides.wrongDigest ? "0".repeat(64) : createHash("sha256").update(native).digest("hex")),
              contentBase64: native.toString("base64") }],
            processIo: overrides.noProcess ? [] : [{ sourceId: "source-1", processId: "process-1", executionId: "exec-1", ordinal: overrides.wrongProcessAttempt ? 2 : 1, providerSessionId: "provider-1", sequence: 0, at: new Date(0).toISOString(), stream: "stdout" as const,
              sizeBytes: stdout.byteLength, sha256: "sha256:" + createHash("sha256").update(stdout).digest("hex"),
              contentBase64: stdout.toString("base64") }],
            processSources: overrides.partial ? [{ sourceId: "source-1", contentBase64: damagedSpool.toString("base64"), sizeBytes: damagedSpool.byteLength,
              sha256: "sha256:" + createHash("sha256").update(damagedSpool).digest("hex") }] : [],
            processTerminals: overrides.missingTerminal || overrides.noProcess ? [] : [{
              sourceId: "source-1", processId: "process-1", executionId: "exec-1", ordinal: 1, providerSessionId: "provider-1", sequence: overrides.badSequence ? 2 : 1, at: new Date(0).toISOString(),
              result: { code: 0, signal: null, timedOut: false, timeoutReason: null, captureError: null },
            }],
            events: [{ metadata: { executionId: "exec-1", sessionId: id, eventCount: overrides.liveCountRace ? 0 : 1 }, frames: [{ type: "native.done", sessionId: id }] }],
            excluded: overrides.excludedCredential ? [{
              sourceId: "source-1", rootScope: "session-home" as const, path: ".config/auth.json",
              kind: "file" as const, mode: 0o600, uid: 1000, gid: 1000,
              mtimeMs: 1, ctimeMs: 1, sizeBytes: 42, reason: "credential" as const,
            }] : [],
            completeness: { nativeStore: !overrides.incomplete, processIo: !overrides.partial, events: true },
            coverageComplete: !overrides.partial,
            missingReasons: overrides.partial ? ["process_io_incomplete"] : [],
          };
          if (!overrides.partial) response.processSources = [spoolSource("source-1", [...response.processIo, ...response.processTerminals])];
          fixtureRawResponses.set(environment, response);
          return response;
        } } : {}),
      };
    },
  } as unknown as SandboxInstanceLike;
  bindTangleEvidenceEnvironment(environment, box);
  fixtureBoxes.set(environment, box);
  noteTangleSession(environment, "session-1", "exec-1");
  return environment;
}

async function readFixtureSource(environment: AgentEnvironment) {
  const box = fixtureBoxes.get(environment);
  if (!box?.session) throw new Error("fixture has no session");
  const originalSession = box.session.bind(box);
  await originalSession("session-1").rawEvidence?.();
  const source = fixtureRawResponses.get(environment);
  if (!source || source.status === "unavailable") throw new Error("fixture has no raw source");
  return { box, originalSession, source };
}

async function rotatedFixture(partial = false) {
  const environment = fixture({ native: true, partial });
  const { box, originalSession, source } = await readFixtureSource(environment);
  source.nativeSessionId = null;
  source.evidenceSources.push({ ...source.evidenceSources[0]!, executionId: "exec-2", sourceId: "source-2",
    runtimeHome: "/home/agent/second-home" });
  source.nativeRoots.push({ sourceId: "source-2", rootScope: "session-home", path: "/home/agent/second-home" });
  source.attempts.push({ ...source.attempts[0]!, executionId: "exec-2", nativeSessionIds: ["native-2"],
    processIds: ["process-2"] });
  const content = Buffer.from("second native source");
  source.files.push({ ...source.files[0]!, sourceId: "source-2", contentBase64: content.toString("base64"),
    sizeBytes: content.byteLength, sha256: "sha256:" + createHash("sha256").update(content).digest("hex") });
  source.inventory.scannedFiles = 2;
  source.inventory.reportedFiles = 2;
  source.processIo.push({ ...source.processIo[0]!, sourceId: "source-2", executionId: "exec-2", processId: "process-2" });
  source.processTerminals.push({ ...source.processTerminals[0]!, sourceId: "source-2", executionId: "exec-2", processId: "process-2" });
  source.processSources.push(spoolSource("source-2", [source.processIo[1], source.processTerminals[1]]));
  source.events.push({ metadata: { executionId: "exec-2", sessionId: "session-1", eventCount: 1 },
    frames: [{ type: "native.done", sessionId: "session-1" }] });
  box.session = (id) => ({ ...originalSession(id),
    async *events(options) { yield { id: "1", type: "execution.completed", data: { executionId: options?.executionId } }; },
    async rawEvidence() { return source; },
  });
  noteTangleSession(environment, "session-1", "exec-2");
  return { environment, source };
}

describe("Tangle evidence capture", () => {

  it.each(["memory", "directory"] as const)("recovers original admitted callers after reconstruction through %s capture", async (mode) => {
    const { environment: original, source } = await rotatedFixture();
    const box = fixtureBoxes.get(original)!;
    const controlRefs: AgentExactRunControlRef[] = ["exec-1", "exec-2"].map((executionId, i) => ({
      runId: "original-" + executionId, provider: original.provider, environmentId: original.id,
      sessionId: "session-1", executionId, requestDigest: `sha256:${String(i + 1).repeat(64)}`,
    }));
    for (const value of source.events) {
      const event = value as { metadata: { executionId: string; eventCount: number }; frames: unknown[] };
      const ref = controlRefs.find(ref => ref.executionId === event.metadata.executionId)!;
      event.frames.unshift({ type: "execution.started", sessionId: ref.sessionId, executionId: ref.executionId,
        data: { sessionId: ref.sessionId, executionId: ref.executionId, runControlRef: ref } });
      event.metadata.eventCount++;
    }
    if (mode === "directory") await directoryExportFixture(original);
    const environment = { id: original.id, provider: original.provider } as AgentEnvironment;
    bindTangleEvidenceEnvironment(environment, box);
    const directory = await mkdtemp(join(tmpdir(), "retained-callers-"));
    try {
      const options = { executionId: "current-runtime-turn", controlRef: controlRefs[1]!,
        harness: "opencode" as const, maxBytes: 100_000 };
      const captured = mode === "directory"
        ? await captureTangleEnvironmentEvidenceToDirectory(environment, { ...options, destination: join(directory, "capture") })
        : await captureTangleEnvironmentEvidence(environment, options);
      expect(captured.provenance.missing).toEqual([]);
      expect(captured.provenance.sessions[0]?.executionIds).toEqual(["exec-2", "exec-1"]);
      expect(captured.provenance.sessions[0]?.controlRefs).toEqual(controlRefs);
      expect(captured.provenance.attempts.map(attempt => attempt.executionId)).toEqual(["exec-1", "exec-2"]);
      expect(captured.provenance.sessions[0]?.nativeStore.complete).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["wrong-anchor", "conflicting", "missing", "malformed", "wrong-environment"] as const)(
    "keeps %s historical caller attribution explicit", async (fault) => {
      const { environment: original, source } = await rotatedFixture();
      const box = fixtureBoxes.get(original)!;
      const refs: AgentExactRunControlRef[] = ["exec-1", "exec-2"].map((executionId, i) => ({
        runId: "original-" + executionId, provider: original.provider, environmentId: original.id,
        sessionId: "session-1", executionId, requestDigest: `sha256:${String(i + 1).repeat(64)}`,
      }));
      for (const value of source.events) {
        const event = value as { metadata: { executionId: string; eventCount: number }; frames: unknown[] };
        const ref = refs.find(ref => ref.executionId === event.metadata.executionId)!;
        if (fault === "missing" && ref.executionId === "exec-1") continue;
        const recorded = { ...ref };
        if (ref.executionId === "exec-1") {
          if (fault === "malformed") recorded.requestDigest = "invalid" as typeof ref.requestDigest;
          if (fault === "wrong-environment") recorded.environmentId = "other-box";
        }
        const frame = { type: "execution.started", sessionId: ref.sessionId, executionId: ref.executionId,
          data: { sessionId: ref.sessionId, executionId: ref.executionId, runControlRef: recorded } };
        event.frames.unshift(frame);
        if (fault === "conflicting" && ref.executionId === "exec-1") event.frames.push({
          ...frame, data: { ...frame.data, runControlRef: { ...ref, requestDigest: `sha256:${"9".repeat(64)}` } },
        });
        event.metadata.eventCount = event.frames.length;
      }
      const environment = { id: original.id, provider: original.provider } as AgentEnvironment;
      bindTangleEvidenceEnvironment(environment, box);
      const anchor = fault === "wrong-anchor" ? { ...refs[1]!, requestDigest: `sha256:${"9".repeat(64)}` as const } : refs[1]!;
      const captured = await captureTangleEnvironmentEvidence(environment, {
        executionId: "current-runtime-turn", controlRef: anchor, harness: "opencode", maxBytes: 100_000,
      });
      expect(captured.provenance.sessions[0]?.executionIds).toEqual(["exec-2"]);
      expect(captured.provenance.sessions[0]?.nativeStore.complete).toBe(false);
      expect(captured.provenance.missing).toContain("Sandbox session session-1 has an execution without retained caller attribution: exec-1");
      expect(captured.files.some(file => file.path.includes("/native/source-1/"))).toBe(true);
    });

  it.each([false, true])("captures exact admitted coordinates after cache loss, partial=%s", async (partial) => {
    const original = fixture({ native: true, partial });
    const box = fixtureBoxes.get(original)!;
    const environment = { id: original.id, provider: original.provider } as AgentEnvironment;
    bindTangleEvidenceEnvironment(environment, box);
    const controlRef: AgentExactRunControlRef = {
      runId: "run-1", provider: "tangle-sandbox", environmentId: "box-1",
      sessionId: "session-1", executionId: "exec-1", requestDigest: `sha256:${"a".repeat(64)}`,
    };
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "frontier:input:1", controlRef, harness: "opencode", maxBytes: 100_000,
    });
    expect(evidence.provenance.executionId).toBe("frontier:input:1");
    expect(evidence.provenance.controlRef).toEqual(controlRef);
    expect(evidence.provenance.sessions[0]).toMatchObject({
      id: "session-1", executionId: "frontier:input:1", executionIds: ["exec-1"],
      eventCountsByExecutionId: { "exec-1": 1 },
    });
    const archived = evidence.files.find((file) => file.path === "__retention__/provenance.json")!;
    expect(JSON.parse(Buffer.from(archived.bytes).toString())).toMatchObject({
      executionId: "frontier:input:1", controlRef,
    });
    expect(evidence.provenance.sessions[0]!.processStreams.complete).toBe(!partial);
    if (partial) expect(evidence.provenance.missing).toContain("Sandbox session session-1: process_io_incomplete");
    else expect(evidence.provenance.missing).toEqual([]);
  });

  it.each(["environment", "provider", "session", "native-execution"])("refuses a mismatched %s control reference before reading files", async (mismatch) => {
    const environment = fixture();
    const box = fixtureBoxes.get(environment)!;
    let reads = 0;
    box.fs!.usage = async () => { reads++; throw new Error("capture should refuse before IO"); };
    const controlRef: AgentExactRunControlRef = {
      runId: "run-1", provider: mismatch === "provider" ? "other-provider" : "tangle-sandbox",
      environmentId: mismatch === "environment" ? "other-box" : "box-1",
      sessionId: "session-1", executionId: mismatch === "native-execution" ? "unsafe:exec" : "exec-1",
      requestDigest: `sha256:${"a".repeat(64)}`,
    };
    await expect(captureTangleEnvironmentEvidence(environment, {
      executionId: "frontier:input:1", controlRef, sandboxSessionId: mismatch === "session" ? "other-session" : "session-1",
      harness: "opencode", maxBytes: 100_000,
    })).rejects.toThrow(/control reference|exact box and execution/);
    expect(reads).toBe(0);
  });

  it("captures pre-CLI unavailability without inventing native identity", async () => {
    const original = fixture();
    const box = fixtureBoxes.get(original)!;
    const session = box.session!.bind(box);
    box.session = (id) => ({ ...session(id), async rawEvidence() {
      return { status: "unavailable", sessionId: id, backendType: "opencode", reason: "harness-never-started" };
    } });
    const environment = { id: original.id, provider: original.provider } as AgentEnvironment;
    bindTangleEvidenceEnvironment(environment, box);
    const controlRef: AgentExactRunControlRef = {
      runId: "run-1", provider: "tangle-sandbox", environmentId: "box-1",
      sessionId: "session-1", executionId: "exec-1", requestDigest: `sha256:${"a".repeat(64)}`,
    };
    const result = await captureTangleEnvironmentEvidence(environment, {
      executionId: "frontier:input:1", controlRef, harness: "opencode", maxBytes: 100_000,
    });
    expect(result.provenance.controlRef).toEqual(controlRef);
    expect(result.provenance.sessions[0]).toMatchObject({ nativeSessionId: null, nativeReason: "harness-never-started" });
    expect(result.provenance.missing).toContain("Raw native session capture for Sandbox session session-1 is unavailable: harness-never-started");
    expect(result.files.some((file) => file.path.endsWith("/raw-manifest.json"))).toBe(true);
  });

  it("preserves a configured provider identity on its admitted capture", async () => {
    const original = fixture({ native: true });
    const environment = { id: original.id, provider: "tangle-research" } as AgentEnvironment;
    bindTangleEvidenceEnvironment(environment, fixtureBoxes.get(original)!);
    const controlRef: AgentExactRunControlRef = {
      runId: "run-1", provider: environment.provider, environmentId: "box-1",
      sessionId: "session-1", executionId: "exec-1", requestDigest: `sha256:${"a".repeat(64)}`,
    };
    const result = await captureTangleEnvironmentEvidence(environment, {
      executionId: "frontier:input:1", controlRef, harness: "opencode", maxBytes: 100_000,
    });
    expect(result.provenance.provider).toBe("tangle-research");
    expect(result.provenance.controlRef).toEqual(controlRef);
    expect(result.provenance.missing).toEqual([]);
  });

  it("continues to refuse path-unsafe native IDs without an admitted reference", async () => {
    await expect(captureTangleEnvironmentEvidence(fixture(), {
      executionId: "frontier:input:1", harness: "opencode", maxBytes: 100_000,
    })).rejects.toThrow("exact box and execution ids");
  });

  it("retains every rotated HOME under a distinct source namespace", async () => {
    const { environment, source } = await rotatedFixture();
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-2", harness: "opencode", maxBytes: 100_000,
    });
    const paths = evidence.files.filter((file) => file.path.endsWith("/.local/share/session.json"));
    expect(paths.map((file) => file.path)).toEqual([
      "__retention__/sessions/session-1/native/source-1/session-home/.local/share/session.json",
      "__retention__/sessions/session-1/native/source-2/session-home/.local/share/session.json",
    ]);
    expect(Buffer.from(paths[0]!.bytes).toString()).toBe('{"session":"native-1"}');
    expect(Buffer.from(paths[1]!.bytes).toString()).toBe("second native source");
    expect(evidence.provenance.sessions[0]?.evidenceSources).toEqual(source.evidenceSources);
    expect(evidence.provenance.sessions[0]?.nativeSessionId).toBeNull();
    expect(evidence.provenance.sessions[0]?.processStreams.processCount).toBe(2);
    expect(evidence.provenance.attempts.map((attempt) => [attempt.executionId, attempt.ordinal])).toEqual([
      ["exec-1", 1], ["exec-2", 1],
    ]);
    expect(evidence.provenance.missing).toEqual([]);
  });

  it("retains conflicting process bytes from separate sources without trusting their attribution", async () => {
    const { environment, source } = await rotatedFixture(true);
    source.attempts.forEach((attempt) => { attempt.processIds = []; });
    source.processIo[1]!.processId = "process-1";
    source.processTerminals[1]!.processId = "process-1";
    source.missingReasons.push("process_source_identity_conflict", "native_source_unavailable:source-1");
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-2", harness: "opencode", maxBytes: 100_000,
    });
    expect(evidence.files.filter((file) => file.path.endsWith("/process-1/0000000000000000-stdout.bin")))
      .toHaveLength(2);
    expect(evidence.provenance.sessions[0]?.processStreams.sources.map((entry) => entry.sourceId))
      .toEqual(["source-1", "source-2"]);
    expect(evidence.provenance.sessions[0]?.processStreams.complete).toBe(false);
    expect(evidence.provenance.missing).toContain("Sandbox session session-1: native_source_unavailable:source-1");
    expect(evidence.provenance.missing).toContain("Sandbox session session-1 process process-1 has no exact attempt attribution");
  });

  it("attributes a reused process ID to its exact source and execution", async () => {
    const { environment, source } = await rotatedFixture();
    source.attempts[1]!.processIds = ["process-1"];
    source.processIo[1]!.processId = "process-1";
    source.processTerminals[1]!.processId = "process-1";
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-2", harness: "opencode", maxBytes: 100_000,
    });
    expect(evidence.provenance.missing).toEqual([]);
    expect(evidence.provenance.sessions[0]?.processStreams).toMatchObject({ complete: true, processCount: 2, terminalCount: 2 });
  });

  it("refuses a complete capture that omits an earlier source root", async () => {
    const { environment, source } = await rotatedFixture();
    source.nativeRoots.shift();
    await expect(captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-2", harness: "opencode", maxBytes: 100_000,
    })).rejects.toThrow(/unretained native source root/);
  });

  it("refuses a complete capture that omits an earlier original process log", async () => {
    const { environment, source } = await rotatedFixture();
    source.processSources.shift();
    await expect(captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-2", harness: "opencode", maxBytes: 100_000,
    })).rejects.toThrow(/omits an original process source/);
  });

  it("keeps readable bytes when an earlier original process log is unavailable", async () => {
    const { environment, source } = await rotatedFixture(true);
    source.processSources.shift();
    source.completeness.processIo = true;
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-2", harness: "opencode", maxBytes: 100_000,
    });
    expect(evidence.provenance.sessions[0]?.processStreams.complete).toBe(false);
    expect(evidence.provenance.sessions[0]?.processStreams.sources.map((entry) => entry.sourceId)).toEqual(["source-2"]);
    expect(evidence.files.filter((file) => file.path.endsWith("-stdout.bin"))).toHaveLength(2);
    expect(evidence.provenance.missing).toContain("Sandbox session session-1 has no original process source: source-1");
  });

  it("keeps a missing process explicit when another source reuses its ID", async () => {
    const { environment, source } = await rotatedFixture(true);
    source.processIo[0]!.sourceId = "source-2";
    source.processTerminals[0]!.sourceId = "source-2";
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-2", harness: "opencode", maxBytes: 100_000,
    });
    expect(evidence.provenance.sessions[0]?.processStreams.complete).toBe(false);
    expect(evidence.provenance.missing).toContain("Sandbox session session-1 attempt exec-1/1 names an unretained attributed process: process-1");
  });
  it("captures the same attributed evidence directly from a Sandbox box", async () => {
    const environment = fixture({ native: true });
    const evidence = await captureTangleSandboxEvidence(fixtureBoxes.get(environment)!, {
      executionId: "exec-1", harness: "opencode", sandboxSessionIds: ["session-1"], maxBytes: 100_000,
    });
    expect(evidence.provenance.environmentId).toBe("box-1");
    expect(evidence.provenance.attempts).toEqual([{ executionId: "exec-1", ordinal: 1, providerSessionId: "provider-1",
      nativeSessionIds: ["native-1"], processIds: ["process-1"], outcome: "succeeded", missingReasons: [] }]);
    expect(evidence.provenance.sessions).toHaveLength(1);
    expect(evidence.provenance.sessions[0]?.nativeStore.roots).toEqual([{ scope: "session-home", path: "/home/agent/session-home", sourceId: "source-1" }]);
    expect(evidence.provenance.sessions[0]).toMatchObject({ id: "session-1", backendType: "opencode", sidecarBundleRevision: "b".repeat(40), nativeStore: { complete: true } });
    expect(evidence.files.map((file) => file.path)).toContain("__retention__/sessions/session-1/native/source-1/session-home/.local/share/session.json");
  });

  it("retains native files and process frames when a terminal receipt is missing", async () => {
    const environment = fixture({ native: true, partial: true, missingTerminal: true });
    const evidence = await captureTangleEnvironmentEvidence(environment, { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 });
    expect(evidence.files.map((file) => file.path)).toContain("__retention__/sessions/session-1/native/source-1/session-home/.local/share/session.json");
    expect(evidence.files.map((file) => file.path)).toContain("__retention__/sessions/session-1/io/source-1/process-1/0000000000000000-stdout.bin");
    expect(evidence.provenance.sessions[0]?.processStreams.complete).toBe(false);
    expect(evidence.provenance.attempts).toHaveLength(1);
    expect(Buffer.from(evidence.files.find((file) => file.path.endsWith("/process-sources/source-1.jsonl"))!.bytes).toString()).toBe('{"unfinished":');
    expect(evidence.provenance.missing).toContain("Sandbox session session-1 declared partial raw capture");
  });

  it("retains raw bytes without attributing an unknown execution to the caller", async () => {
    const environment = fixture({ native: true, wrongAttempt: true });
    const evidence = await captureTangleEnvironmentEvidence(environment, { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 });
    expect(evidence.provenance.attempts).toEqual([]);
    expect(evidence.provenance.missing).toContain("Sandbox session session-1 has an execution without retained caller attribution: unrelated-exec");
    const manifest = evidence.files.find((file) => file.path.endsWith("/raw-manifest.json"))!;
    expect(JSON.parse(Buffer.from(manifest.bytes).toString()).source.attempts[0].executionId).toBe("unrelated-exec");
    expect(evidence.files.map((file) => file.path)).toContain("__retention__/sessions/session-1/native/source-1/session-home/.local/share/session.json");
  });

  it("keeps earlier session history after reconnect while marking missing caller attribution", async () => {
    const { environment } = await rotatedFixture();
    const evidence = await captureTangleSandboxEvidence(fixtureBoxes.get(environment)!, {
      executionId: "logical-node", harness: "opencode", sandboxSessionIds: ["session-1"],
      sessionExecutionIds: { "session-1": ["exec-2"] }, maxBytes: 100_000,
    });
    expect(evidence.provenance.attempts.map((attempt) => attempt.executionId)).toEqual(["exec-2"]);
    expect(evidence.provenance.sessions[0]?.nativeStore.complete).toBe(false);
    expect(evidence.provenance.sessions[0]?.nativeEvents.complete).toBe(false);
    expect(evidence.provenance.missing).toContain("Sandbox session session-1 has an execution without retained caller attribution: exec-1");
    expect(evidence.files.filter((file) => file.path.endsWith("/.local/share/session.json"))).toHaveLength(2);
    const manifest = evidence.files.find((file) => file.path.endsWith("/raw-manifest.json"))!;
    expect(JSON.parse(Buffer.from(manifest.bytes).toString()).source.attempts.map((attempt: { executionId: string }) => attempt.executionId))
      .toEqual(["exec-1", "exec-2"]);
  });

  it("rejects a process frame tagged to a different retry", async () => {
    const environment = fixture({ native: true, wrongProcessAttempt: true });
    await expect(captureTangleEnvironmentEvidence(environment, { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 }))
      .rejects.toThrow(/conflicting attempt attribution/);
  });

  it("retains a valid attempt that started no process", async () => {
    const environment = fixture({ native: true, noProcess: true });
    const evidence = await captureTangleEnvironmentEvidence(environment, { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 });
    expect(evidence.provenance.attempts[0]?.processIds).toEqual([]);
    expect(evidence.provenance.missing).toEqual([]);
  });

  it("retains a live partial buffer when its reported count races the observed frames", async () => {
    const environment = fixture({ native: true, partial: true, liveCountRace: true });
    const evidence = await captureTangleEnvironmentEvidence(environment, { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 });
    expect(evidence.provenance.sessions[0]?.nativeEvents.complete).toBe(false);
    const manifest = evidence.files.find((file) => file.path.endsWith("/raw-manifest.json"));
    expect(JSON.parse(Buffer.from(manifest!.bytes).toString()).source.events[0].metadata.eventCount).toBe(0);
  });

  it("reconstructs the complete raw response with every metadata field and exact source byte", async () => {
    const environment = fixture({ native: true, partial: true });
    const { box, originalSession, source } = await readFixtureSource(environment);
    Object.assign(source, { producer: { revision: "source-revision", cost: null, hidden: false, count: 0 },
      skipped: [], contentRefs: "producer-owned-field" });
    Object.assign(source.files[0]!, { futureStat: { birthtimeMs: 2 } });
    Object.assign(source.processIo[0]!, { futureTransport: "socket", metadata: { nested: [null, 0, false] } });
    Object.assign(source.processTerminals[0]!.result, { futureUsage: { tokens: null } });
    Object.assign(source.attempts[0]!, { startedAt: "1970-01-01T00:00:00.000Z" });
    box.session = (id) => ({ ...originalSession(id), async rawEvidence() { return source; } });
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 100_000,
    });
    const artifact = evidence.files.find((file) => file.path.endsWith("/raw-manifest.json"))!;
    const manifest = JSON.parse(Buffer.from(artifact.bytes).toString());
    expect(manifest.kind).toBe("tangle-native-session-evidence.v1");
    expect(manifest.contentEncoding).toBe("base64");
    for (const reference of manifest.contentRefs) {
      const bytes = evidence.files.find((file) => file.path === reference.path)!.bytes;
      const path = reference.jsonPointer.slice(1).split("/");
      const key = path.pop()!;
      const target = path.reduce((parent: Record<string, unknown>, segment: string) => parent[segment], manifest.source);
      target[key] = Buffer.from(bytes).toString("base64");
    }
    expect(manifest.source).toEqual(JSON.parse(JSON.stringify(source)));
    expect(evidence.files.filter((file) => /\/(process-manifest|native-events)\.json$/.test(file.path))).toEqual([]);
  });

  it("refuses a skipped-entry count that differs from the source manifest", async () => {
    const environment = fixture({ native: true, partial: true });
    const { box, originalSession, source } = await readFixtureSource(environment);
    Object.assign(source, { skipped: [{ sourceId: "source-1", rootScope: "session-home", path: "missing.json", reason: "entry_unreadable" }] });
    box.session = (id) => ({ ...originalSession(id), async rawEvidence() { return source; } });
    await expect(captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 100_000,
    })).rejects.toThrow(/skipped inventory does not reconcile/);
  });

  it("preserves the original metadata when native capture is unavailable", async () => {
    const environment = fixture({ native: true });
    const { box, originalSession } = await readFixtureSource(environment);
    const source = { status: "unavailable" as const, sessionId: "session-1", backendType: "opencode",
      reason: "native_source_unavailable", producer: { attempts: null, checkedAt: "1970-01-01T00:00:00.000Z" } };
    box.session = (id) => ({ ...originalSession(id), async rawEvidence() { return source; } });
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 100_000,
    });
    const manifest = evidence.files.find((file) => file.path.endsWith("/raw-manifest.json"))!;
    expect(JSON.parse(Buffer.from(manifest.bytes).toString())).toEqual({
      kind: "tangle-native-session-evidence.v1", source, contentEncoding: "base64", contentRefs: [],
    });
    expect(evidence.provenance.sessions[0]?.nativeReason).toBe("native_source_unavailable");
  });

  it("binds native bytes to the verified create container", async () => {
    const environment = fixture({ native: true, proof: true });
    const evidence = await captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 100_000, requireNativeSessionCapture: true,
    });
    expect(evidence.provenance.captureProof).toMatchObject({ containerId: "c".repeat(64) });
    const wrong = fixture({ native: true, proof: true, wrongProof: true });
    await expect(captureTangleEnvironmentEvidence(wrong, {
      executionId: "exec-1", harness: "opencode", maxBytes: 100_000, requireNativeSessionCapture: true,
    })).rejects.toThrow(/identity differs from verified create proof/);
  });

  it("rejects native capture without a canonical served sidecar bundle revision", async () => {
    const environment = fixture({ native: true, missingBundleRevision: true });
    await expect(captureTangleSandboxEvidence(fixtureBoxes.get(environment)!, {
      executionId: "exec-1", harness: "opencode", sandboxSessionIds: ["session-1"], maxBytes: 100_000,
    })).rejects.toThrow(/sidecar bundle revision/);
  });

  it("scopes a direct capture to the exact worker directory", async () => {
    const environment = fixture({ native: true, workerRoot: "workers/shot-1" });
    const evidence = await captureTangleSandboxEvidence(fixtureBoxes.get(environment)!, {
      executionId: "exec-1", harness: "opencode", sandboxSessionIds: ["session-1"],
      workspaceRoot: "workers/shot-1", maxBytes: 100_000,
    });
    expect(evidence.provenance.workspaceRoot).toBe("workers/shot-1");
    expect(evidence.files.map((file) => file.path)).toContain("notes/.finding.json");
    expect(evidence.files.map((file) => file.path)).not.toContain("workers/shot-1/notes/.finding.json");
  });

  it("captures hidden binary workspace files and attributed replay with explicit native gap", async () => {
    const evidence = await captureTangleEnvironmentEvidence(fixture(), { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 });
    expect([...evidence.files.find((file) => file.path === "notes/.finding.json")!.bytes]).toEqual([0, 1, 255]);
    expect(evidence.files.map((file) => file.path)).toContain("__retention__/sessions/session-1.json");
    expect(evidence.provenance.workspace.complete).toBe(true);
    expect(evidence.provenance.sessions[0]).toMatchObject({ id: "session-1", eventCount: 1, messageCount: 1, nativeStore: { complete: false } });
    expect(evidence.provenance.missing).toContain("Raw native session capture for Sandbox session session-1 is unavailable: raw-session-capture-capability-absent");
  });

  function multiFileWorkspace(sizes: number[]) {
    const environment = fixture({ native: true, proof: true });
    const box = fixtureBoxes.get(environment)!;
    const fs = box.fs!;
    const contents = sizes.map((size, index) => ({
      path: `notes/result-${index}.bin`,
      bytes: Buffer.alloc(size, index % 256),
      mode: index % 2 ? 0o755 : 0o600,
    }));
    const calls: string[][] = [];
    fs.usage = async () => ({
      sizeBytes: sizes.reduce((total, size) => total + size, 0),
      fileCount: sizes.length, directoryCount: 1, complete: true, skippedEntries: 0,
    });
    const list = fs.list!.bind(fs);
    fs.list = async (path, options) => path === "." ? list(path, options) : contents.map((file) => ({
      path: file.path, name: file.path.split("/").at(-1)!, size: file.bytes.byteLength,
      isDir: false, isFile: true, isSymlink: false, permissions: file.mode,
    }));
    fs.readBatch = async (paths) => {
      calls.push([...paths]);
      return {
        files: paths.map((path) => {
          const file = contents.find((entry) => entry.path === path);
          if (!file) throw new Error("fixture received an unexpected path");
          return { path, content: file.bytes.toString("base64"), encoding: "base64" as const,
            size: file.bytes.byteLength, hash: createHash("sha256").update(file.bytes).digest("hex") };
        }).reverse(),
        errors: [],
      };
    };
    return { environment, box, contents, calls };
  }

  it("batches workspace reads while preserving exact binary bytes, modes, order, and native proof", async () => {
    const f = multiFileWorkspace(Array.from({ length: 250 }, (_, index) => index % 19));
    const evidence = await captureTangleEnvironmentEvidence(f.environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 100_000, requireNativeSessionCapture: true,
    });
    expect(f.calls.map((paths) => paths.length)).toEqual([100, 100, 50]);
    const retained = evidence.files.filter((file) => file.path.startsWith("notes/"));
    expect(retained.map(({ path, mode }) => ({ path, mode }))).toEqual(
      f.contents.slice().sort((a, b) => a.path.localeCompare(b.path)).map(({ path, mode }) => ({ path, mode })),
    );
    for (const file of retained) {
      expect(Buffer.from(file.bytes).equals(f.contents.find((item) => item.path === file.path)!.bytes)).toBe(true);
    }
    expect(evidence.provenance.workspace).toMatchObject({ scannedFiles: 250, reportedFiles: 250, complete: true });
    expect(evidence.provenance.missing).toEqual([]);
  });

  it("bounds each multi-file response by declared bytes as well as file count", async () => {
    const f = multiFileWorkspace([3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024]);
    const evidence = await captureTangleEnvironmentEvidence(f.environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 12 * 1024 * 1024,
    });
    expect(f.calls.map((paths) => paths.length)).toEqual([2, 1]);
    const retained = evidence.files.filter((file) => file.path.startsWith("notes/"));
    expect(retained.map(({ path, mode }) => ({ path, mode }))).toEqual(
      f.contents.slice().sort((a, b) => a.path.localeCompare(b.path)).map(({ path, mode }) => ({ path, mode })),
    );
    for (const file of retained) {
      expect(Buffer.from(file.bytes).equals(f.contents.find((item) => item.path === file.path)!.bytes)).toBe(true);
    }
  });

  it.each(["missing", "duplicate", "unexpected", "conflicting", "duplicate-error"])(
    "refuses a %s batch response instead of accepting incomplete or misattributed bytes",
    async (failure) => {
      const f = multiFileWorkspace([3, 4, 5]);
      const readBatch = f.box.fs!.readBatch.bind(f.box.fs);
      f.box.fs!.readBatch = async (paths, options) => {
        const result = await readBatch(paths, options);
        if (failure === "missing") return { ...result, files: result.files.slice(1) };
        if (failure === "duplicate") return { ...result, files: [...result.files, result.files[0]!] };
        if (failure === "unexpected") return { ...result, files: [...result.files, { ...result.files[0]!, path: "other/result.bin" }] };
        const error = { path: paths[0]!, code: "FILE_TOO_LARGE", error: "JSON cap" };
        return failure === "conflicting" ? { ...result, errors: [error] } :
          { files: result.files.filter((file) => file.path !== paths[0]), errors: [error, error] };
      };
      await expect(captureTangleEnvironmentEvidence(f.environment, {
        executionId: "exec-1", harness: "opencode", maxBytes: 100_000,
      })).rejects.toThrow(/batch|workspace file/);
    },
  );

  it("stops before another batch when capture is cancelled during the read", async () => {
    const f = multiFileWorkspace(Array.from({ length: 250 }, () => 3));
    const abort = new AbortController();
    const readBatch = f.box.fs!.readBatch.bind(f.box.fs);
    f.box.fs!.readBatch = async (paths, options) => {
      const result = await readBatch(paths, options);
      abort.abort(new Error("capture cancelled"));
      return result;
    };
    await expect(captureTangleEnvironmentEvidence(f.environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 100_000, signal: abort.signal,
    })).rejects.toThrow("capture cancelled");
    expect(f.calls).toHaveLength(1);
  });

  function largeWorkspace() {
    const environment = fixture({ native: true, proof: true });
    const box = fixtureBoxes.get(environment)!;
    const fs = box.fs!;
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 0xa5);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const downloads: Array<{ path: string; target: string; options: { maxBytes?: number; expectedSize?: number; signal?: AbortSignal } | undefined }> = [];
    fs.usage = async () => ({ sizeBytes: bytes.byteLength, fileCount: 1, directoryCount: 1, complete: true, skippedEntries: 0 });
    const list = fs.list!.bind(fs);
    fs.list = async (path, options) => (await list(path, options)).map((entry) => ({
      ...entry, ...(entry.isFile ? { size: bytes.byteLength } : {}),
    }));
    fs.readBatch = async (paths) => ({ files: [], errors: [{ path: paths[0]!, code: "FILE_TOO_LARGE", error: "JSON read limit" }] });
    fs.supportsBoundedDownload = true;
    fs.download = async (path, target, options) => {
      downloads.push({ path, target, options });
      await writeFile(target, bytes);
      return { sizeBytes: bytes.byteLength, sha256 };
    };
    return { environment, box, bytes, sha256, downloads };
  }

  it("captures files above the JSON cap with exact bytes and complete native proof", async () => {
    const f = largeWorkspace();
    const signal = new AbortController().signal;
    const maxBytes = f.bytes.byteLength + 100_000;
    const evidence = await captureTangleEnvironmentEvidence(f.environment, {
      executionId: "exec-1", harness: "opencode", maxBytes, signal, requireNativeSessionCapture: true,
    });
    const retained = evidence.files.find((file) => file.path === "notes/.finding.json")!;
    expect(createHash("sha256").update(retained.bytes).digest("hex")).toBe(f.sha256);
    expect(retained.bytes.byteLength).toBe(f.bytes.byteLength);
    expect(f.downloads).toHaveLength(1);
    expect(f.downloads[0]!.options).toEqual({ maxBytes, expectedSize: f.bytes.byteLength, signal });
    await expect(stat(f.downloads[0]!.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(evidence.provenance.missing).toEqual([]);
    expect(evidence.provenance.captureProof).toMatchObject({ containerId: "c".repeat(64) });
    expect(evidence.provenance.sessions[0]!.nativeStore.complete).toBe(true);
  });

  it("isolates an oversized file between batches and preserves binary download fallback", async () => {
    const f = multiFileWorkspace([3, 10 * 1024 * 1024 + 1, 4]);
    const fs = f.box.fs!;
    const readBatch = fs.readBatch.bind(fs);
    const large = f.contents[1]!;
    const downloads: string[] = [];
    fs.readBatch = async (paths, options) => {
      const result = await readBatch(paths, options);
      return {
        files: result.files.filter((file) => file.path !== large.path),
        errors: paths.includes(large.path) ? [{ path: large.path, code: "FILE_TOO_LARGE", error: "JSON cap" }] : [],
      };
    };
    fs.supportsBoundedDownload = true;
    fs.download = async (path, target, options) => {
      downloads.push(path);
      expect(options?.expectedSize).toBe(large.bytes.byteLength);
      await writeFile(target, large.bytes);
      return { sizeBytes: large.bytes.byteLength, sha256: createHash("sha256").update(large.bytes).digest("hex") };
    };
    const evidence = await captureTangleEnvironmentEvidence(f.environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 12 * 1024 * 1024, requireNativeSessionCapture: true,
    });
    expect(f.calls).toEqual(f.contents.map((file) => [file.path]));
    expect(downloads).toEqual([large.path]);
    for (const file of f.contents) {
      const retained = evidence.files.find((item) => item.path === file.path)!;
      expect(Buffer.from(retained.bytes).equals(file.bytes)).toBe(true);
      expect(retained.mode).toBe(file.mode);
    }
    expect(evidence.provenance.missing).toEqual([]);
  });

  it.each(["receipt", "size", "hash", "cancel"])("refuses %s failure on a binary download and removes its private copy", async (failure) => {
    const f = largeWorkspace();
    const abort = new AbortController();
    const download = f.box.fs!.download!;
    f.box.fs!.download = async (path, target, options) => {
      const receipt = await download(path, target, options);
      if (failure === "receipt") return;
      if (failure === "size") await writeFile(target, "short");
      if (failure === "hash") {
        const bytes = await readFile(target);
        bytes[0] ^= 0xff;
        await writeFile(target, bytes);
      }
      if (failure === "cancel") abort.abort(new Error("capture cancelled"));
      return receipt;
    };
    await expect(captureTangleEnvironmentEvidence(f.environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: f.bytes.byteLength + 100_000,
      signal: abort.signal, requireNativeSessionCapture: true,
    })).rejects.toMatchObject({ message: failure === "receipt"
      ? "Tangle evidence binary download omitted its exact size or digest receipt"
      : failure === "size" ? "Tangle evidence workspace file changed or was truncated: notes/.finding.json"
      : failure === "hash" ? "Tangle evidence workspace file hash mismatch: notes/.finding.json"
      : "capture cancelled" });
    await expect(stat(f.downloads[0]!.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the bounded download capability and preserves other read failures", async () => {
    const f = largeWorkspace();
    delete f.box.fs!.supportsBoundedDownload;
    const options = { executionId: "exec-1", harness: "opencode" as const, maxBytes: f.bytes.byteLength + 100_000 };
    await expect(captureTangleEnvironmentEvidence(f.environment, options)).rejects.toMatchObject({ message: "Tangle evidence requires bounded binary download for workspace file notes/.finding.json" });
    f.box.fs!.supportsBoundedDownload = true;
    f.box.fs!.readBatch = async (paths) => ({ files: [], errors: [{ path: paths[0]!, code: "EIO", error: "unavailable" }] });
    await expect(captureTangleEnvironmentEvidence(f.environment, options)).rejects.toMatchObject({ message: "Tangle evidence could not read workspace file notes/.finding.json" });
    expect(f.downloads).toHaveLength(0);
  });

  it("enforces the aggregate limit before downloading an oversized file", async () => {
    const f = largeWorkspace();
    await expect(captureTangleEnvironmentEvidence(f.environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: f.bytes.byteLength - 1,
    })).rejects.toThrow(/byte limit/);
    expect(f.downloads).toHaveLength(0);
  });

  it("excludes credential files before considering binary downloads", async () => {
    const f = largeWorkspace();
    f.box.fs!.usage = async () => ({ sizeBytes: f.bytes.byteLength, fileCount: 1, directoryCount: 0, complete: true, skippedEntries: 0 });
    f.box.fs!.list = async () => [{ path: ".env", name: ".env", size: f.bytes.byteLength,
      isFile: true, isDir: false, isSymlink: false, permissions: 0o600 }];
    f.box.fs!.readBatch = async () => { throw new Error("credential read forbidden"); };
    const evidence = await captureTangleEnvironmentEvidence(f.environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: f.bytes.byteLength + 100_000,
      requireNativeSessionCapture: true,
    });
    expect(f.downloads).toHaveLength(0);
    expect(evidence.files.some((file) => file.path === ".env")).toBe(false);
    expect(evidence.provenance.excludedPaths).toContainEqual(expect.objectContaining({ path: ".env", reason: "credential-path" }));
  });

  it.each(["size", "hash"])("includes the exact workspace path in JSON %s failures", async (failure) => {
    const environment = fixture();
    const fs = fixtureBoxes.get(environment)!.fs!;
    const readBatch = fs.readBatch!;
    fs.readBatch = async (paths, options) => {
      const result = await readBatch(paths, options);
      return { ...result, files: result.files.map((file) => ({
        ...file, ...(failure === "size" ? { content: "AA==" } : { hash: "0".repeat(64) }),
      })) };
    };
    await expect(captureTangleEnvironmentEvidence(environment, {
      executionId: "exec-1", harness: "opencode", maxBytes: 100_000,
    })).rejects.toMatchObject({ message: failure === "size"
      ? "Tangle evidence workspace file changed or was truncated: notes/.finding.json"
      : "Tangle evidence workspace file hash mismatch: notes/.finding.json" });
  });

  it("refuses an incomplete inventory or a failed binary read", async () => {
    await expect(captureTangleEnvironmentEvidence(fixture({ complete: false }), { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 })).rejects.toThrow(/incomplete/);
    await expect(captureTangleEnvironmentEvidence(fixture({ readError: true }), { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 })).rejects.toMatchObject({ message: "Tangle evidence could not read workspace file notes/.finding.json" });
  });

  it("verifies and retains the exact native OpenCode export", async () => {
    const evidence = await captureTangleEnvironmentEvidence(fixture({ native: true }), { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 });
    expect(evidence.provenance.sessions[0]).toMatchObject({ nativeStore: { complete: true }, processStreams: { complete: true, stdoutBytes: 14 }, nativeEvents: { complete: true }, nativeSessionId: "native-1" });
    expect(evidence.provenance.missing).toEqual([]);
    expect(evidence.files.some((file) => file.path === "__retention__/sessions/session-1/native/source-1/session-home/.local/share/session.json")).toBe(true);
  });

  it("rejects false raw bytes, unrelated backends, and incomplete native stores", async () => {
    const options = { executionId: "exec-1", harness: "opencode" as const, maxBytes: 100_000 };
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, wrongDigest: true }), options)).rejects.toThrow(/do not match/);
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, wrongBackend: true }), options)).rejects.toThrow(/unrelated/);
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, incomplete: true }), options)).rejects.toThrow(/incomplete/);
  });

  it("reconciles declared credential metadata and process terminal boundaries", async () => {
    const options = { executionId: "exec-1", harness: "opencode" as const, maxBytes: 100_000 };
    const evidence = await captureTangleEnvironmentEvidence(fixture({ native: true, excludedCredential: true }), options);
    expect(evidence.provenance.missing).toEqual([]);
    expect(evidence.provenance.sessions[0]?.nativeStore.excludedPaths).toEqual([expect.objectContaining({
      path: ".config/auth.json", kind: "file", mode: 0o600, sizeBytes: 42, reason: "credential",
    })]);
    expect(evidence.provenance.sessions[0]?.processStreams).toMatchObject({
      complete: true, processCount: 1, terminalCount: 1,
    });
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, missingTerminal: true }), options))
      .rejects.toThrow(/without a terminal/);
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, badSequence: true }), options))
      .rejects.toThrow(/sequence is incomplete/);
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, badInventory: true }), options))
      .rejects.toThrow(/inventory does not reconcile/);
  });

  it("refuses a path outside the listed workspace parent", async () => {
    await expect(captureTangleEnvironmentEvidence(fixture({ filePath: "../secret" }), { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 })).rejects.toThrow(/canonical/);
  });
});

describe("bounded directory evidence", () => {
  it.each([false, true])("preserves the legacy archive bytes and provenance, partial=%s", async (partial) => {
    const environment = fixture({ native: true, partial, excludedCredential: true });
    const root = await mkdtemp(join(tmpdir(), "provider-evidence-test-"));
    const options = { executionId: "exec-1", harness: "opencode" as const, maxBytes: 1_000_000 };
    try {
      const expected = await captureTangleEnvironmentEvidence(environment, options);
      const exported = await directoryExportFixture(environment);
      const actual = await captureTangleEnvironmentEvidenceToDirectory(environment, { ...options, destination: join(root, "capture") });
      expect({ ...actual.provenance, capturedAt: expected.provenance.capturedAt }).toEqual(expected.provenance);
      for (const file of expected.files) {
        const bytes = await readFile(join(actual.directory, file.path));
        if (file.path === "__retention__/provenance.json") {
          expect({ ...JSON.parse(bytes.toString()), capturedAt: expected.provenance.capturedAt }).toEqual(JSON.parse(Buffer.from(file.bytes).toString()));
        } else expect(bytes).toEqual(Buffer.from(file.bytes));
        expect((await stat(join(actual.directory, file.path))).mode & 0o777).toBe(file.mode);
      }
      await expect(stat(exported.exportedDirectory()!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["payload", "records", "manifest", "truncated", "identity"] as const)("refuses %s corruption and removes owned staging", async (corrupt) => {
    const environment = fixture({ native: true });
    const root = await mkdtemp(join(tmpdir(), "provider-evidence-test-"));
    try {
      const exported = await directoryExportFixture(environment, { corrupt });
      const destination = join(root, "capture");
      await expect(captureTangleEnvironmentEvidenceToDirectory(environment, {
        executionId: "exec-1", harness: "opencode", maxBytes: 1_000_000, destination,
      })).rejects.toThrow();
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(exported.exportedDirectory()!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("removes capture and native staging on cancellation", async () => {
    const environment = fixture({ native: true });
    const controller = new AbortController();
    const root = await mkdtemp(join(tmpdir(), "provider-evidence-test-"));
    try {
      const exported = await directoryExportFixture(environment, { afterExport: () => controller.abort() });
      const destination = join(root, "capture");
      await expect(captureTangleEnvironmentEvidenceToDirectory(environment, {
        executionId: "exec-1", harness: "opencode", maxBytes: 1_000_000, destination, signal: controller.signal,
      })).rejects.toThrow();
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(exported.exportedDirectory()!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses unsupported native export without invoking the aggregate route", async () => {
    const environment = fixture({ native: true });
    const box = fixtureBoxes.get(environment)!;
    const session = box.session!.bind(box);
    let aggregateReads = 0;
    box.session = id => ({ ...session(id), async rawEvidence() { aggregateReads++; throw new Error("aggregate"); } });
    const root = await mkdtemp(join(tmpdir(), "provider-evidence-test-"));
    try {
      const destination = join(root, "capture");
      await expect(captureTangleEnvironmentEvidenceToDirectory(environment, {
        executionId: "exec-1", harness: "opencode", maxBytes: 1_000_000, destination,
      })).rejects.toThrow(/requires bounded native export/);
      expect(aggregateReads).toBe(0);
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves existing destination content", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-evidence-test-"));
    try {
      await writeFile(join(root, "owned.txt"), "existing");
      await expect(captureTangleEnvironmentEvidenceToDirectory(fixture(), {
        executionId: "exec-1", harness: "opencode", maxBytes: 1_000_000, destination: root,
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(join(root, "owned.txt"), "utf8")).toBe("existing");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
