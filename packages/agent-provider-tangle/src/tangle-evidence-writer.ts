import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { coalesceEvidenceChunks } from "./tangle-evidence-json.js";
import type { SandboxInstanceLike } from "./tangle-types.js";

type FileSystem = NonNullable<SandboxInstanceLike["fs"]>;
type EvidenceFile = { path: string; bytes: Uint8Array; mode: number };
export interface EvidenceWriter {
  readonly byteLength: number;
  readonly directory?: string;
  write(file: EvidenceFile): Promise<void>;
  writeChunks(path: string, mode: number, chunks: AsyncIterable<Uint8Array>): Promise<number>;
  download?(fs: FileSystem, file: { sourcePath: string; path: string; size: number; mode: number }): Promise<void>;
}

function limits(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Tangle evidence maxBytes must be positive");
}

function filePath(path: string, mode: number): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      path.split("/").some(part => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error("Tangle evidence output has an unsafe path or mode");
  }
}

async function* one(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

/** Compatibility collector. Directory capture uses the streaming writer below. */
export function createMemoryEvidenceWriter(maxBytes: number, signal?: AbortSignal): EvidenceWriter & { files: EvidenceFile[] } {
  limits(maxBytes);
  let total = 0;
  const files: EvidenceFile[] = [];
  const seen = new Set<string>();
  const writer = {
    files,
    get byteLength() { return total; },
    async write(file: EvidenceFile) { await writer.writeChunks(file.path, file.mode, one(file.bytes)); },
    async writeChunks(path: string, mode: number, chunks: AsyncIterable<Uint8Array>) {
      filePath(path, mode);
      if (seen.has(path)) throw new Error("Tangle evidence repeats an output path");
      seen.add(path);
      const retained: Buffer[] = [];
      let size = 0;
      for await (const bytes of coalesceEvidenceChunks(chunks)) {
        signal?.throwIfAborted();
        if (bytes.byteLength > maxBytes - total - size) throw new Error("Tangle evidence exceeds byte limit");
        retained.push(Buffer.from(bytes));
        size += bytes.byteLength;
      }
      signal?.throwIfAborted();
      files.push({ path, mode, bytes: Buffer.concat(retained, size) });
      total += size;
      return size;
    },
  };
  return writer;
}

/** One fresh private tree, streamed writes and hash-verified bounded downloads. */
export async function createDirectoryEvidenceWriter(destination: string, maxBytes: number, signal?: AbortSignal): Promise<EvidenceWriter & { directory: string; remove(): Promise<void> }> {
  limits(maxBytes);
  signal?.throwIfAborted();
  if (!destination) throw new Error("Tangle evidence destination is required");
  const requested = resolve(destination);
  await mkdir(requested, { mode: 0o700 });
  const directory = await realpath(requested);
  let total = 0;
  const seen = new Set<string>();
  const prepare = async (path: string, mode: number) => {
    signal?.throwIfAborted();
    filePath(path, mode);
    if (seen.has(path)) throw new Error("Tangle evidence repeats an output path");
    seen.add(path);
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    return target;
  };
  const writer = {
    directory,
    get byteLength() { return total; },
    async remove() { await rm(directory, { recursive: true, force: true }); },
    async write(file: EvidenceFile) { await writer.writeChunks(file.path, file.mode, one(file.bytes)); },
    async writeChunks(path: string, mode: number, chunks: AsyncIterable<Uint8Array>) {
      const target = await prepare(path, mode);
      const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      let size = 0;
      try {
        for await (const bytes of coalesceEvidenceChunks(chunks)) {
          signal?.throwIfAborted();
          if (bytes.byteLength > maxBytes - total - size) throw new Error("Tangle evidence exceeds byte limit");
          let offset = 0;
          while (offset < bytes.byteLength) {
            const result = await output.write(bytes, offset, bytes.byteLength - offset);
            if (result.bytesWritten === 0) throw new Error("Tangle evidence output made no progress");
            offset += result.bytesWritten;
          }
          size += bytes.byteLength;
        }
        signal?.throwIfAborted();
        await output.chmod(mode);
        await output.sync();
      } finally { await output.close(); }
      total += size;
      return size;
    },
    async download(fs: FileSystem, file: { sourcePath: string; path: string; size: number; mode: number }) {
      if (fs.supportsBoundedDownload !== true || !fs.download) throw new Error("Tangle evidence requires bounded binary download");
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes - total) throw new Error("Tangle evidence exceeds byte limit");
      const target = await prepare(file.path, file.mode);
      const receipt = await fs.download(file.sourcePath, target, { maxBytes: maxBytes - total, expectedSize: file.size, signal });
      signal?.throwIfAborted();
      if (!receipt || receipt.sizeBytes !== file.size || !/^[a-f0-9]{64}$/i.test(receipt.sha256)) throw new Error("Tangle evidence binary download omitted its exact size or digest receipt");
      const descriptor = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const hash = createHash("sha256");
      let size = 0;
      try {
        const stat = await descriptor.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.size) throw new Error("Tangle evidence downloaded file differs from its receipt");
        const buffer = Buffer.allocUnsafe(256 * 1024);
        for (;;) {
          signal?.throwIfAborted();
          const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > file.size) throw new Error("Tangle evidence downloaded file grew during verification");
          hash.update(buffer.subarray(0, bytesRead));
        }
      } finally { await descriptor.close(); }
      if (size !== file.size || hash.digest("hex") !== receipt.sha256.toLowerCase()) throw new Error("Tangle evidence downloaded file does not match its digest");
      signal?.throwIfAborted();
      await chmod(target, file.mode);
      total += size;
    },
  };
  return writer;
}
