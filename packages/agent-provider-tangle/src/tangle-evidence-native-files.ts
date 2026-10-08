import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceJsonArray } from "./tangle-evidence-json.js";
import type { SandboxSessionLike, TangleRawEvidenceLike } from "./tangle-types.js";

type Captured = Exclude<TangleRawEvidenceLike, { status: "unavailable" }>;
type WithoutInline<T> = Omit<T, "contentBase64"> & { contentBase64?: string };
export type RetainedNativeEvidence = Exclude<TangleRawEvidenceLike, Captured> | (
  Omit<Captured, "processIo" | "processSources"> & {
    processIo: Array<WithoutInline<Captured["processIo"][number]>>;
    processSources: Array<WithoutInline<Captured["processSources"][number]>>;
  }
);
export interface NativePayloadFile { path: string; sizeBytes: number; sha256: string }
interface RecordsFile extends NativePayloadFile { format: "ndjson"; records: number }
export interface PreparedNativeEvidence {
  native: RetainedNativeEvidence | undefined;
  payloads: WeakMap<object, NativePayloadFile>;
  directory?: string;
  remove(): Promise<void>;
}
const MAX_ENTRIES = 100_000;
// Match the shipped Sandbox archive reader: a valid producer manifest or NDJSON
// record must not be rejected after capture solely by this consumer's bound.
export const MAX_METADATA_BYTES = 64 * 1024 * 1024;
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tangle native export metadata is malformed");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error("Tangle native export metadata exceeds its record bound");
  return value;
}
function payload(value: unknown, maxBytes: number): NativePayloadFile {
  const item = record(value);
  if (typeof item.path !== "string" || !item.path || item.path.startsWith("/") || item.path.includes("\\") || item.path.includes("\0") ||
      item.path.split("/").some(part => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 0 || Number(item.sizeBytes) > maxBytes ||
      typeof item.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.sha256)) {
    throw new Error("Tangle native export file reference is invalid");
  }
  return { path: item.path, sizeBytes: Number(item.sizeBytes), sha256: item.sha256 };
}
function recordsFile(value: unknown, maxBytes: number): RecordsFile {
  const item = record(value);
  if (item.format !== "ndjson" || !Number.isSafeInteger(item.records) || Number(item.records) < 0 || Number(item.records) > MAX_ENTRIES) {
    throw new Error("Tangle native export record inventory is invalid");
  }
  return { ...payload(item, maxBytes), format: "ndjson", records: Number(item.records) };
}

/** Exact receipt validation is repeated while consuming, so a later local mutation fails capture. */
export async function* nativePayloadChunks(directory: string, ref: NativePayloadFile, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const checked = payload(ref, ref.sizeBytes);
  signal?.throwIfAborted();
  const handle = await open(join(directory, checked.path), constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let size = 0;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== checked.sizeBytes) throw new Error("Tangle native export file differs from its receipt");
    for (;;) {
      signal?.throwIfAborted();
      const bytes = Buffer.allocUnsafe(64 * 1024);
      const result = await handle.read(bytes, 0, bytes.length, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (size > checked.sizeBytes) throw new Error("Tangle native export file grew during capture");
      const chunk = bytes.subarray(0, result.bytesRead);
      hash.update(chunk);
      yield chunk;
    }
    const after = await handle.stat();
    if (size !== checked.sizeBytes || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        `sha256:${hash.digest("hex")}` !== checked.sha256) throw new Error("Tangle native export file does not match its digest");
    signal?.throwIfAborted();
  } finally { await handle.close(); }
}

async function* nativeRecords(directory: string, ref: RecordsFile, signal?: AbortSignal): AsyncIterable<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let count = 0;
  for await (const chunk of nativePayloadChunks(directory, ref, signal)) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line || Buffer.byteLength(line) > MAX_RECORD_BYTES || ++count > ref.records) throw new Error("Tangle native export has an invalid record boundary");
      yield JSON.parse(line);
    }
    if (Buffer.byteLength(pending) > MAX_RECORD_BYTES) throw new Error("Tangle native export record exceeds its memory bound");
  }
  pending += decoder.decode();
  if (pending || count !== ref.records) throw new Error("Tangle native export is truncated or has a different record count");
}

/** The new route must never fall back to the legacy aggregate JSON request. */
export async function prepareNativeDirectoryEvidence(session: SandboxSessionLike, maxBytes: number, signal?: AbortSignal): Promise<PreparedNativeEvidence> {
  if (!session.exportRawEvidence) throw new Error("Tangle directory evidence requires bounded native export; aggregate capture is not a fallback");
  const temporary = await mkdtemp(join(tmpdir(), "tangle-native-evidence-"));
  const destination = join(temporary, "export");
  const remove = () => rm(temporary, { recursive: true, force: true });
  try {
    const response = record(await session.exportRawEvidence(destination, { maxBytes, maxFiles: MAX_ENTRIES, signal }));
    if (response.status === "unavailable") {
      return { native: response as unknown as RetainedNativeEvidence, payloads: new WeakMap(), remove };
    }
    if ((response.status !== "captured" && response.status !== "partial") || response.directory !== destination ||
        typeof response.manifestPath !== "string" || !response.manifestPath.startsWith(destination + "/") ||
        typeof response.manifestSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(response.manifestSha256)) {
      throw new Error("Tangle native export receipt has invalid identity");
    }
    // Read the authenticated on-disk metadata, not a second, potentially divergent object.
    const manifestPath = response.manifestPath.slice(destination.length + 1);
    payload({ path: manifestPath, sizeBytes: 0, sha256: response.manifestSha256 }, MAX_METADATA_BYTES);
    const metadataHandle = await open(response.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let metadataRef: NativePayloadFile;
    try {
      const stat = await metadataHandle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_METADATA_BYTES) throw new Error("Tangle native metadata exceeds its memory bound");
      metadataRef = payload({ path: manifestPath, sizeBytes: stat.size, sha256: response.manifestSha256 }, MAX_METADATA_BYTES);
    } finally { await metadataHandle.close(); }
    const metadataChunks: Uint8Array[] = [];
    for await (const chunk of nativePayloadChunks(destination, metadataRef, signal)) metadataChunks.push(chunk);
    const metadataBytes = Buffer.concat(metadataChunks, metadataRef.sizeBytes);
    const manifest = record(JSON.parse(metadataBytes.toString("utf8")));
    if (manifest.schema !== "tangle.raw-evidence-archive.v1" || manifest.status !== response.status || manifest.sessionId !== session.id) throw new Error("Tangle native export manifest names another session or protocol");
    const payloads = new WeakMap<object, NativePayloadFile>();
    const prepareContent = (value: unknown) => {
      const item = record(value);
      const { content, ...metadata } = item;
      if (content !== undefined) {
        const ref = payload(content, maxBytes);
        if (item.contentBase64 !== undefined || item.sizeBytes !== ref.sizeBytes || item.sha256 !== ref.sha256) throw new Error("Tangle native payload receipt differs from its metadata");
        payloads.set(metadata, ref);
      }
      return metadata;
    };
    const files = array(manifest.files).map(prepareContent);
    const processSources = array(manifest.processSources).map(prepareContent);
    let metadataSize = metadataBytes.length;
    const boundMetadata = (item: unknown) => {
      metadataSize += Buffer.byteLength(JSON.stringify(item));
      if (metadataSize > MAX_METADATA_BYTES) throw new Error("Tangle native metadata exceeds its memory bound");
    };
    const processIo: Record<string, unknown>[] = [];
    for await (const entry of nativeRecords(destination, recordsFile(manifest.processIo, maxBytes), signal)) {
      const item = prepareContent(entry);
      boundMetadata(item);
      processIo.push(item);
    }
    const processTerminals: unknown[] = [];
    for await (const entry of nativeRecords(destination, recordsFile(manifest.processTerminals, maxBytes), signal)) {
      boundMetadata(entry);
      processTerminals.push(entry);
    }
    const events = array(manifest.events).map(value => {
      const entry = record(value);
      const ref = recordsFile(entry.frames, maxBytes);
      return { metadata: entry.metadata, frames: new EvidenceJsonArray(ref.records, () => nativeRecords(destination, ref, signal)) };
    });
    const { schema: _schema, ...legacyMetadata } = manifest;
    // The existing evidence validator checks all identity, attribution and completeness fields.
    const native = { ...legacyMetadata, files, processIo, processTerminals, processSources, events } as unknown as RetainedNativeEvidence;
    return { native, payloads, directory: destination, remove };
  } catch (error) { await remove(); throw error; }
}
