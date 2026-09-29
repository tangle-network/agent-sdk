import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxInstanceLike } from "./tangle-types.js";
import { assertTangleEvidenceCapability, assertTangleEvidenceProfileCapability, bindTangleEvidenceEnvironment, captureTangleEnvironmentEvidence, noteTangleSession, readTangleEvidenceCapabilities } from "./tangle-evidence.js";

function fixture(overrides: { complete?: boolean; filePath?: string; readError?: boolean; native?: boolean } = {}) {
  const environment = { id: "box-1", provider: "tangle-sandbox" } as AgentEnvironment;
  const filePath = overrides.filePath ?? "notes/.finding.json";
  const content = Buffer.from([0, 1, 255]);
  const box = {
    id: "box-1",
    fs: {
      async usage() { return { sizeBytes: 3, fileCount: 1, directoryCount: 1, complete: overrides.complete ?? true, skippedEntries: 0 }; },
      async list(path: string) {
        return path === "."
          ? [{ name: "notes", path: "notes", size: 0, isDir: true, isFile: false, isSymlink: false, permissions: 0o755 }]
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
        ...(overrides.native ? { async nativeRollout() {
          const bytes = Buffer.from('{"session":"native-1"}');
          return {
            status: "captured" as const,
            sessionId: id,
            backendType: "opencode" as const,
            nativeSessionId: "native-1",
            format: "opencode-session-export-json" as const,
            sizeBytes: bytes.byteLength,
            sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            contentBase64: bytes.toString("base64"),
          };
        } } : {}),
      };
    },
  } as unknown as SandboxInstanceLike;
  bindTangleEvidenceEnvironment(environment, box);
  noteTangleSession(environment, "session-1", "exec-1");
  return environment;
}

describe("Tangle evidence capture", () => {
  it("rejects unsupported harnesses and unknown deployment capability before create", async () => {
    const client = { async evidenceCapabilities() { return {
      workspaceCaptureV1: true,
      nativeRolloutExportV1: { opencode: true },
      sidecarImageDigest: `sha256:${"a".repeat(64)}`,
    }; } } as unknown as Parameters<typeof assertTangleEvidenceCapability>[0];
    await expect(assertTangleEvidenceCapability(client, { harness: "opencode" })).resolves.toBeUndefined();
    const proof = await readTangleEvidenceCapabilities(client);
    expect(() => assertTangleEvidenceProfileCapability(proof, { harness: "opencode" })).not.toThrow();
    expect(() => assertTangleEvidenceProfileCapability(proof, { harness: "codex" })).toThrow(/requires OpenCode/);
    expect(() => assertTangleEvidenceProfileCapability({ ...proof }, { harness: "opencode" })).toThrow(/not read from the deployment/);
    await expect(assertTangleEvidenceCapability(client, { harness: "claude-code" })).rejects.toThrow(/requires OpenCode/);
    await expect(assertTangleEvidenceCapability({} as Parameters<typeof assertTangleEvidenceCapability>[0], { harness: "opencode" })).rejects.toThrow(/no pre-create/);
  });
  it("captures hidden binary workspace files and attributed replay with explicit native gap", async () => {
    const evidence = await captureTangleEnvironmentEvidence(fixture(), { executionId: "exec-1", maxBytes: 100_000 });
    expect([...evidence.files.find((file) => file.path === "notes/.finding.json")!.bytes]).toEqual([0, 1, 255]);
    expect(evidence.files.map((file) => file.path)).toContain("__retention__/sessions/session-1.json");
    expect(evidence.provenance.workspace.complete).toBe(true);
    expect(evidence.provenance.sessions[0]).toMatchObject({ id: "session-1", eventCount: 1, messageCount: 1, nativeRollout: "unavailable" });
    expect(evidence.provenance.missing).toContain("Native harness rollout for Sandbox session session-1 is unavailable: native-export-capability-absent");
  });

  it("refuses an incomplete inventory or a failed binary read", async () => {
    await expect(captureTangleEnvironmentEvidence(fixture({ complete: false }), { executionId: "exec-1", maxBytes: 100_000 })).rejects.toThrow(/incomplete/);
    await expect(captureTangleEnvironmentEvidence(fixture({ readError: true }), { executionId: "exec-1", maxBytes: 100_000 })).rejects.toThrow(/could not read/);
  });

  it("verifies and retains the exact native OpenCode export", async () => {
    const evidence = await captureTangleEnvironmentEvidence(fixture({ native: true }), { executionId: "exec-1", maxBytes: 100_000 });
    expect(evidence.provenance.sessions[0]).toMatchObject({ nativeRollout: "complete", nativeSessionId: "native-1" });
    expect(evidence.provenance.missing).toEqual([]);
    expect(evidence.files.some((file) => file.path === "__retention__/sessions/session-1.native.json")).toBe(true);
  });

  it("refuses a path outside the listed workspace parent", async () => {
    await expect(captureTangleEnvironmentEvidence(fixture({ filePath: "../secret" }), { executionId: "exec-1", maxBytes: 100_000 })).rejects.toThrow(/canonical/);
  });
});
