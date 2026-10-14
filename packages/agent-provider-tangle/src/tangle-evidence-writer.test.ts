import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDirectoryEvidenceWriter } from "./tangle-evidence-writer.js";

it("syncs by default and permits verified temporary staging without per-file sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-writer-test-"));
  const probe = await open(join(root, "probe"), "w");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = vi.spyOn(fileHandlePrototype, "sync").mockRejectedValue(new Error("sync failed"));
  try {
    const defaultWriter = await createDirectoryEvidenceWriter(join(root, "default"), 1000);
    await expect(defaultWriter.write({ path: "sample.txt", bytes: Buffer.from("exact bytes"), mode: 0o600 })).rejects.toThrow("sync failed");
    const stagedWriter = await createDirectoryEvidenceWriter(join(root, "staged"), 1000, undefined, false);
    await stagedWriter.write({ path: "sample.txt", bytes: Buffer.from("exact bytes"), mode: 0o600 });
    expect(await readFile(join(root, "staged", "sample.txt"), "utf8")).toBe("exact bytes");
    expect((await stat(join(root, "staged", "sample.txt"))).mode & 0o777).toBe(0o600);
    expect(sync).toHaveBeenCalledTimes(1);
  } finally {
    sync.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
