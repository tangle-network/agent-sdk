import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxInstanceLike } from "./tangle-types.js";
import { assertTangleEvidenceCapability, assertTangleEvidenceProfileCapability, bindTangleEvidenceEnvironment, captureTangleEnvironmentEvidence, captureTangleSandboxEvidence, noteTangleSession, readTangleEvidenceCapabilities } from "./tangle-evidence.js";

const fixtureBoxes = new WeakMap<AgentEnvironment, SandboxInstanceLike>();

function fixture(overrides: { complete?: boolean; filePath?: string; readError?: boolean; native?: boolean; wrongDigest?: boolean; wrongBackend?: boolean; incomplete?: boolean; workerRoot?: string } = {}) {
  const environment = { id: "box-1", provider: "tangle-sandbox" } as AgentEnvironment;
  const root = overrides.workerRoot ?? ".";
  const filePath = overrides.filePath ?? (root === "." ? "notes/.finding.json" : root + "/notes/.finding.json");
  const content = Buffer.from([0, 1, 255]);
  const box = {
    id: "box-1",
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
          return {
            status: "captured" as const,
            sessionId: id,
            backendType: overrides.wrongBackend ? "codex" : "opencode",
            nativeSessionId: "native-1",
            nativeRoots: [{ scope: "session-home" as const, path: "." }],
            inventory: { scannedFiles: 1, reportedFiles: 1, scannedDirectories: 0, reportedDirectories: 0, scannedSymlinks: 0, reportedSymlinks: 0, skippedEntries: 0 as const },
            files: [{ rootScope: "session-home" as const, path: ".local/share/session.json", kind: "file" as const, mode: 0o600,
              sizeBytes: native.byteLength, sha256: "sha256:" + (overrides.wrongDigest ? "0".repeat(64) : createHash("sha256").update(native).digest("hex")),
              contentBase64: native.toString("base64") }],
            processIo: [{ sequence: 0, at: new Date(0).toISOString(), stream: "stdout" as const,
              sizeBytes: stdout.byteLength, sha256: "sha256:" + createHash("sha256").update(stdout).digest("hex"),
              contentBase64: stdout.toString("base64") }],
            events: [{ type: "native.done", sessionId: id }],
            excluded: [],
            completeness: { nativeStore: !overrides.incomplete as true, processIo: true as const, events: true as const },
          };
        } } : {}),
      };
    },
  } as unknown as SandboxInstanceLike;
  bindTangleEvidenceEnvironment(environment, box);
  fixtureBoxes.set(environment, box);
  noteTangleSession(environment, "session-1", "exec-1");
  return environment;
}

describe("Tangle evidence capture", () => {
  it("requires generic native capture attestation and an exact profile harness before create", async () => {
    const client = { async evidenceCapabilities() { return {
      workspaceCaptureV1: true,
      nativeSessionCaptureV1: true,
      sidecarImageDigest: "sha256:" + "a".repeat(64),
    }; } } as unknown as Parameters<typeof assertTangleEvidenceCapability>[0];
    const proof = await readTangleEvidenceCapabilities(client);
    for (const harness of ["opencode", "pi", "codex", "claude-code", "kimi-code", "hermes"] as const) {
      await expect(assertTangleEvidenceCapability(client, { harness })).resolves.toBeUndefined();
      expect(() => assertTangleEvidenceProfileCapability(proof, { harness })).not.toThrow();
    }
    expect(() => assertTangleEvidenceProfileCapability(proof, {})).toThrow(/exact profile harness/);
    expect(() => assertTangleEvidenceProfileCapability({ ...proof }, { harness: "opencode" })).toThrow(/not read from the deployment/);
    await expect(assertTangleEvidenceCapability({} as Parameters<typeof assertTangleEvidenceCapability>[0], { harness: "opencode" })).rejects.toThrow(/no pre-create/);
    const unproven = { async evidenceCapabilities() { return { workspaceCaptureV1: true, nativeSessionCaptureV1: false, sidecarImageDigest: "sha256:" + "a".repeat(64) }; } };
    await expect(readTangleEvidenceCapabilities(unproven as unknown as Parameters<typeof readTangleEvidenceCapabilities>[0])).rejects.toThrow(/has not proven/);
  });
  it("captures the same attributed evidence directly from a Sandbox box", async () => {
    const environment = fixture({ native: true });
    const evidence = await captureTangleSandboxEvidence(fixtureBoxes.get(environment)!, {
      executionId: "exec-1", harness: "opencode", sandboxSessionIds: ["session-1"], maxBytes: 100_000,
    });
    expect(evidence.provenance.environmentId).toBe("box-1");
    expect(evidence.provenance.sessions).toHaveLength(1);
    expect(evidence.provenance.sessions[0]).toMatchObject({ id: "session-1", backendType: "opencode", nativeStore: { complete: true } });
    expect(evidence.files.map((file) => file.path)).toContain("__retention__/sessions/session-1/native/session-home/.local/share/session.json");
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
    expect(evidence.files.some((file) => file.path === "__retention__/sessions/session-1/native/session-home/.local/share/session.json")).toBe(true);
  });

  it("rejects false raw bytes, unrelated backends, and incomplete native stores", async () => {
    const options = { executionId: "exec-1", harness: "opencode" as const, maxBytes: 100_000 };
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, wrongDigest: true }), options)).rejects.toThrow(/do not match/);
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, wrongBackend: true }), options)).rejects.toThrow(/unrelated/);
    await expect(captureTangleEnvironmentEvidence(fixture({ native: true, incomplete: true }), options)).rejects.toThrow(/incomplete/);
  });

  it("refuses a path outside the listed workspace parent", async () => {
    await expect(captureTangleEnvironmentEvidence(fixture({ filePath: "../secret" }), { executionId: "exec-1", harness: "opencode", maxBytes: 100_000 })).rejects.toThrow(/canonical/);
  });
});
