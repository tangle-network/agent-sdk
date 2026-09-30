import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxInstanceLike, TangleRawEvidenceLike } from "./tangle-types.js";
import { assertTangleEvidenceCapability, assertTangleEvidenceProfileCapability, bindTangleEvidenceEnvironment, captureTangleEnvironmentEvidence, captureTangleSandboxEvidence, noteTangleSession, readTangleEvidenceCapabilities } from "./tangle-evidence.js";

const fixtureBoxes = new WeakMap<AgentEnvironment, SandboxInstanceLike>();
const fixtureRawResponses = new WeakMap<AgentEnvironment, TangleRawEvidenceLike>();

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
  it("requires explicit native capture admission for the exact profile harness before create", async () => {
    const client = { async evidenceCapabilities() { return {
      workspaceCaptureV1: true,
      nativeSessionCaptureV1: false, nativeSessionCaptureVersion: 2,
      nativeSessionCaptureHarnesses: ["opencode", "pi", "codex", "claude-code", "kimi-code", "hermes"],
      sidecarImageDigest: "sha256:" + "a".repeat(64),
    }; } } as unknown as Parameters<typeof assertTangleEvidenceCapability>[0];
    const proof = await readTangleEvidenceCapabilities(client);
    for (const harness of ["opencode", "pi", "codex", "claude-code", "kimi-code", "hermes"] as const) {
      await expect(assertTangleEvidenceCapability(client, { harness })).resolves.toBeUndefined();
      expect(() => assertTangleEvidenceProfileCapability(proof, { harness })).not.toThrow();
    }
    expect(() => assertTangleEvidenceProfileCapability(proof, {})).toThrow(/exact profile harness/);
    expect(() => assertTangleEvidenceProfileCapability(proof, { harness: "future-unregistered" as never }))
      .toThrow();
    expect(() => assertTangleEvidenceProfileCapability({ ...proof }, { harness: "opencode" })).toThrow(/not read from the deployment/);
    await expect(assertTangleEvidenceCapability({} as Parameters<typeof assertTangleEvidenceCapability>[0], { harness: "opencode" })).rejects.toThrow(/no pre-create/);
    const unproven = { async evidenceCapabilities() { return { workspaceCaptureV1: true, nativeSessionCaptureV1: false, nativeSessionCaptureVersion: 2, sidecarImageDigest: "sha256:" + "a".repeat(64) }; } };
    await expect(readTangleEvidenceCapabilities(unproven as unknown as Parameters<typeof readTangleEvidenceCapabilities>[0])).rejects.toThrow(/has not proven/);
  });
  it.each([undefined, 1, 3])("refuses an unknown or incompatible capture protocol %j", async (version) => {
    const client = { async evidenceCapabilities() { return {
      workspaceCaptureV1: true, nativeSessionCaptureV1: true, nativeSessionCaptureVersion: version,
      nativeSessionCaptureHarnesses: ["opencode"], sidecarImageDigest: "sha256:" + "a".repeat(64),
    }; } } as unknown as Parameters<typeof readTangleEvidenceCapabilities>[0];
    await expect(readTangleEvidenceCapabilities(client)).rejects.toThrow(/has not proven/);
  });

  it("does not widen a selected-harness admission from the generic flag or later source mutation", async () => {
    const listed = ["opencode"];
    const client = { async evidenceCapabilities() { return {
      workspaceCaptureV1: true, nativeSessionCaptureV1: true, nativeSessionCaptureVersion: 2,
      nativeSessionCaptureHarnesses: listed,
      sidecarImageDigest: "sha256:" + "a".repeat(64),
    }; } } as unknown as Parameters<typeof readTangleEvidenceCapabilities>[0];
    const proof = await readTangleEvidenceCapabilities(client);
    listed.push("claude-code");
    expect(() => assertTangleEvidenceProfileCapability(proof, { harness: "opencode" })).not.toThrow();
    expect(() => assertTangleEvidenceProfileCapability(proof, { harness: "claude-code" })).toThrow(/has not proven/);
    expect(Object.isFrozen(proof.nativeSessionCaptureHarnesses)).toBe(true);
  });

  it.each([undefined, ["opencode", "opencode"], ["future-unregistered"]])("refuses malformed deployment harness list %j", async (listed) => {
    const client = { async evidenceCapabilities() { return {
      workspaceCaptureV1: true, nativeSessionCaptureV1: true, nativeSessionCaptureVersion: 2,
      nativeSessionCaptureHarnesses: listed,
      sidecarImageDigest: "sha256:" + "a".repeat(64),
    }; } } as unknown as Parameters<typeof readTangleEvidenceCapabilities>[0];
    await expect(readTangleEvidenceCapabilities(client)).rejects.toThrow(/valid harness list/);
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

  it("refuses an incomplete inventory or a failed binary read", async () => {
    await expect(captureTangleEnvironmentEvidence(fixture({ complete: false }), { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 })).rejects.toThrow(/incomplete/);
    await expect(captureTangleEnvironmentEvidence(fixture({ readError: true }), { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 })).rejects.toThrow(/could not read/);
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
