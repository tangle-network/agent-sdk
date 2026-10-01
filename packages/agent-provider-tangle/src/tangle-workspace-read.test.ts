import { createHash } from "node:crypto";
import { environmentReader, resolveSpawnResourcePaths } from "@tangle-network/agent-runtime/mcp";
import { describe, expect, it, vi } from "vitest";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";
import { MAX_PAYLOAD_STRING_BYTES, MAX_STRING_LENGTH } from "./tangle-contract-safety.js";

async function workspace(content: string) {
  const boxRead = vi.fn(async () => content);
  const box: SandboxInstanceLike = {
    id: "workspace-read-box",
    status: "running",
    async *streamPrompt() {},
    delete: async () => undefined,
    read: boxRead,
  };
  const provider = createTangleProvider({
    client: {
      create: async () => { throw new Error("Read must not create an environment"); },
      get: async () => box,
    },
  });
  if (!provider.get) throw new Error("Provider get is unavailable");
  const environment = await provider.get(box.id);
  if (!environment?.read) throw new Error("Workspace read is unavailable");
  return { environment: { id: environment.id, read: environment.read.bind(environment) }, boxRead };
}

describe("Tangle workspace reads use the resource payload byte bound", () => {
  it.each([MAX_STRING_LENGTH + 1, 3 * 1024 * 1024, MAX_PAYLOAD_STRING_BYTES])(
    "preserves all bytes of a %i-byte file through the public provider",
    async (bytes) => {
      const content = "x".repeat(bytes);
      const { environment } = await workspace(content);
      await expect(environment.read("inputs/source-part.b64")).resolves.toBe(content);
    },
  );

  it("refuses an ASCII payload beyond the existing file-resource bound", async () => {
    const { environment } = await workspace("x".repeat(MAX_PAYLOAD_STRING_BYTES + 1));
    await expect(environment.read("inputs/source-part.b64")).rejects.toThrow("Tangle file content exceeds its bound");
  });

  it("counts UTF-8 bytes instead of JavaScript string length", async () => {
    const content = "é".repeat(MAX_PAYLOAD_STRING_BYTES / 2);
    const { environment } = await workspace(content);
    await expect(environment.read("inputs/source.txt")).resolves.toBe(content);
    const oversized = await workspace(content + "é");
    await expect(oversized.environment.read("inputs/source.txt")).rejects.toThrow("Tangle file content exceeds its bound");
  });

  it("keeps the control-plane path bound before reading", async () => {
    const { environment, boxRead } = await workspace("small");
    await expect(environment.read("x".repeat(MAX_STRING_LENGTH + 1))).rejects.toThrow("Tangle path exceeds its bound");
    expect(boxRead).not.toHaveBeenCalled();
  });

  it("resolves a 3 MiB source reference with the exact bytes and journal identity", async () => {
    const content = "a".repeat(3 * 1024 * 1024);
    const { environment, boxRead } = await workspace(content);
    const authored = {
      name: "source-child",
      resources: {
        files: [{ path: "inputs/source-part.b64", resource: { kind: "inline", name: "source-part", path: "inputs/source-part.b64" } }],
      },
    };
    const result = await resolveSpawnResourcePaths(authored, environmentReader(environment));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.resolved).toEqual([{
      at: "files[0].resource",
      path: "inputs/source-part.b64",
      byteLength: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content).digest("hex"),
    }]);
    expect(result.profile).toEqual({
      name: "source-child",
      resources: { files: [{ path: "inputs/source-part.b64", resource: { kind: "inline", name: "source-part", content } }] },
    });
    expect(authored.resources.files[0].resource).not.toHaveProperty("content");
    expect(boxRead).toHaveBeenCalledOnce();
  });
});
