import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SandboxInstanceLike } from "./tangle-types.js";
import { captureTangleSandboxEvidence } from "./tangle-evidence.js";

/**
 * A box whose filesystem is a real local directory: list, usage and readBatch read the tree,
 * and openArchive streams GNU tar output, members named as the Sidecar names them. The
 * capture's inventory, exclusions and retained bytes are checked against the tree itself.
 */
async function directoryBox(root: string, archived: string[], corrupt = false): Promise<SandboxInstanceLike> {
  const entry = async (path: string) => {
    const stat = await lstat(join(root, path));
    return { name: path.split("/").at(-1)!, path, size: stat.size, isDir: stat.isDirectory(), isFile: stat.isFile(),
      isSymlink: stat.isSymbolicLink(), permissions: stat.mode & 0o7777, owner: String(stat.uid), group: String(stat.gid), modTime: stat.mtime };
  };
  const usage = async (path: string) => {
    let sizeBytes = 0, fileCount = 0, directoryCount = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const name of await readdir(join(root, directory))) {
        const item = await entry(directory === "." ? name : `${directory}/${name}`);
        if (item.isDir && !item.isSymlink) { directoryCount++; await walk(item.path); } else { fileCount++; sizeBytes += item.size; }
      }
    };
    await walk(path);
    return { sizeBytes, fileCount, directoryCount, complete: true, skippedEntries: 0 };
  };
  return {
    id: "directory-box",
    fs: {
      async list(path: string) { return Promise.all((await readdir(join(root, path))).map((name) => entry(path === "." ? name : `${path}/${name}`))); },
      usage,
      async readBatch(paths: string[]) {
        return { files: await Promise.all(paths.map(async (path) => {
          const bytes = await readFile(join(root, path));
          return { path, content: bytes.toString("base64"), encoding: "base64" as const, size: bytes.byteLength, hash: createHash("sha256").update(bytes).digest("hex") };
        })), errors: [] };
      },
      async openArchive(directory: string) {
        archived.push(directory);
        const { stdout } = await promisify(execFile)("tar", ["-cz", "-C", join(root, directory), ...(await readdir(join(root, directory))).sort()],
          { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
        // Flip one byte in the middle of the compressed stream.
        if (corrupt) stdout[stdout.byteLength >> 1] ^= 0xff;
        return new Blob([stdout]).stream();
      },
      async stat(path: string) { const stat = await lstat(join(root, path)); return { size: stat.size, isFile: stat.isFile() }; },
    },
  } as unknown as SandboxInstanceLike;
}

async function workspace(root: string) {
  const files: Record<string, Buffer> = {};
  const put = async (path: string, bytes: Buffer, mode = 0o644) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes, { mode });
    files[path] = bytes;
  };
  for (let index = 0; index < 120; index++) {
    await put(`repo/pkg${index % 7}/src/file-${index}.ts`, Buffer.from(`export const value${index} = ${index};\n`.repeat(index + 1)), index % 3 ? 0o644 : 0o755);
  }
  // Names past the 100-byte ustar field travel in long-name records.
  await put(`repo/${"deep-directory-name/".repeat(8)}leaf.bin`, Buffer.from([0, 1, 2, 255, 254]), 0o600);
  await put("repo/blob.bin", Buffer.alloc(3 * 1024 * 1024, 0x5a));
  await put("notes.md", Buffer.from("# notes\n"));
  await link(join(root, "repo/pkg1/src/file-1.ts"), join(root, "repo/hard-link.ts"));
  files["repo/hard-link.ts"] = files["repo/pkg1/src/file-1.ts"]!;
  await symlink("pkg1", join(root, "repo/pkg-link"));
  // Credential paths below and at the top level; their bytes must never be retained.
  await mkdir(join(root, "repo/.config/tool"), { recursive: true });
  await writeFile(join(root, "repo/.config/tool/token"), "nested secret");
  await writeFile(join(root, "repo/.env.local"), "A=1");
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(join(root, ".codex/auth.json"), "top secret");
  return files;
}

describe("Tangle evidence workspace archive", () => {
  it("retains the exact tree through one archive per top-level directory and never archives credential directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-archive-"));
    try {
      const files = await workspace(root);
      const archived: string[] = [];
      // No archive byte may be staged on disk.
      const before = (await readdir(tmpdir())).filter((name) => name.startsWith("tangle-evidence-"));
      const evidence = await captureTangleSandboxEvidence(await directoryBox(root, archived), {
        executionId: "exec-1", harness: "opencode", sandboxSessionIds: [], maxBytes: 64 * 1024 * 1024,
      });
      expect(archived).toEqual(["repo"]);
      const retained = Object.fromEntries(evidence.files.filter((file) => !file.path.startsWith("__retention__")).map((file) => [file.path, file]));
      expect(Object.keys(retained).sort()).toEqual(Object.keys(files).sort());
      for (const [path, bytes] of Object.entries(files)) {
        expect(Buffer.from(retained[path]!.bytes).equals(bytes), path).toBe(true);
        expect(retained[path]!.mode).toBe((await lstat(join(root, path))).mode & 0o777);
      }
      const usage = await (await directoryBox(root, [])).fs!.usage!(".");
      expect(evidence.provenance.workspace).toMatchObject({ scannedFiles: usage.fileCount, scannedDirectories: usage.directoryCount, complete: true });
      expect(evidence.provenance.workspace.archives).toEqual([expect.objectContaining({ path: "repo", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
      expect((await readdir(tmpdir())).filter((name) => name.startsWith("tangle-evidence-"))).toEqual(before);
      const excluded = Object.fromEntries(evidence.provenance.excludedPaths.map((entry) => [entry.path, entry.reason]));
      expect(excluded).toEqual({ ".codex": "credential-path", "repo/.config": "credential-path", "repo/.env.local": "credential-path", "repo/pkg-link": "symlink" });
      expect(evidence.provenance.entries.some((entry) => entry.path.startsWith("repo/.config/"))).toBe(false);
      const entry = evidence.provenance.entries.find((item) => item.path === "repo/pkg2/src/file-2.ts")!;
      const stat = await lstat(join(root, "repo/pkg2/src/file-2.ts"));
      expect(entry).toMatchObject({ type: "file", sizeBytes: stat.size, owner: String(stat.uid), group: String(stat.gid),
        modifiedAt: new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toISOString() });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a corrupted archive stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-archive-"));
    try {
      await workspace(root);
      await expect(captureTangleSandboxEvidence(await directoryBox(root, [], true), {
        executionId: "exec-1", harness: "opencode", sandboxSessionIds: [], maxBytes: 64 * 1024 * 1024,
      })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
