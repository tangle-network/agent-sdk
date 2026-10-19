/**
 * Streaming reader for the Sandbox directory archive (`fs.downloadArchive`): ustar headers as the
 * Sidecar's node-tar writes them, with PAX `x` records and GNU `L`/`K` long names. Every header
 * checksum is verified, and a member's body must be consumed or is skipped before the next header
 * is read, so memory stays bounded by one header block plus one source chunk.
 */
export interface WorkspaceArchiveMember {
  /** Member name relative to the archived directory, without a trailing slash. */
  name: string;
  type: "file" | "directory" | "symlink" | "link";
  /** Body bytes for a file; 0 for every other type. */
  size: number;
  mode: number;
  uid: number;
  gid: number;
  /** Seconds since the epoch; fractional only when a PAX record carries sub-second time. */
  mtime: number;
  /** Symlink target or hard link target member name; empty for other types. */
  linkName: string;
  body: AsyncIterable<Uint8Array>;
}

const BLOCK = 512;
// Bounds a PAX or GNU long-name record, which the reader holds in memory.
const MAX_METADATA_BYTES = 1024 * 1024;

class ArchiveBytes {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private ended = false;
  private readonly source: AsyncIterator<Uint8Array>;
  constructor(source: AsyncIterator<Uint8Array>) { this.source = source; }

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.source.next();
    if (next.done) { this.ended = true; return false; }
    if (next.value.byteLength) { this.chunks.push(next.value); this.buffered += next.value.byteLength; }
    return true;
  }

  async exact(length: number): Promise<Uint8Array> {
    while (this.buffered < length) if (!await this.fill()) throw new Error("Tangle workspace archive is truncated");
    const out = new Uint8Array(length);
    let offset = 0;
    for await (const piece of this.span(length)) { out.set(piece, offset); offset += piece.byteLength; }
    return out;
  }

  /** The next buffered piece, at most `limit` bytes. */
  async next(limit: number): Promise<Uint8Array> {
    if (!this.buffered && !await this.fill()) throw new Error("Tangle workspace archive is truncated");
    const head = this.chunks[0]!;
    const piece = head.byteLength <= limit ? head : head.subarray(0, limit);
    if (piece === head) this.chunks.shift(); else this.chunks[0] = head.subarray(limit);
    this.buffered -= piece.byteLength;
    return piece;
  }

  async *span(length: number): AsyncGenerator<Uint8Array> {
    for (let left = length; left > 0;) {
      const piece = await this.next(left);
      left -= piece.byteLength;
      yield piece;
    }
  }

  async *rest(): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (!this.buffered && !await this.fill()) return;
      const head = this.chunks.shift()!;
      this.buffered -= head.byteLength;
      yield head;
    }
  }
}

function text(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString("utf8");
}

function number(block: Uint8Array, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  if (field[0]! & 0x80) {
    // GNU base-256: a positive big-endian value after the marker bit.
    if (field[0]! & 0x40) throw new Error("Tangle workspace archive has a negative numeric field");
    let value = field[0]! & 0x3f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) throw new Error("Tangle workspace archive numeric field is too large");
    return value;
  }
  const digits = text(block, offset, length).trim();
  if (!digits) return 0;
  if (!/^[0-7]+$/.test(digits)) throw new Error("Tangle workspace archive has an invalid numeric field");
  const value = parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) throw new Error("Tangle workspace archive numeric field is too large");
  return value;
}

function verifyChecksum(block: Uint8Array): void {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  if (sum !== number(block, 148, 8)) throw new Error("Tangle workspace archive header checksum mismatch");
}

function paxRecords(bytes: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const source = Buffer.from(bytes);
  let offset = 0;
  while (offset < source.byteLength) {
    const space = source.indexOf(0x20, offset);
    if (space === -1) throw new Error("Tangle workspace archive has a malformed PAX record");
    const length = Number(source.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > source.byteLength ||
        source[offset + length - 1] !== 0x0a) {
      throw new Error("Tangle workspace archive has a malformed PAX record");
    }
    const record = source.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error("Tangle workspace archive has a malformed PAX record");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

function paxNumber(value: string | undefined, fallback: number, integer: boolean): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error("Tangle workspace archive has an invalid PAX number");
  }
  return parsed;
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** Yield each member once; an unconsumed body is skipped when the next member is requested. */
export async function* readWorkspaceArchive(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<WorkspaceArchiveMember> {
  const bytes = new ArchiveBytes(chunks[Symbol.asyncIterator]());
  let pax: Map<string, string> | undefined;
  let longName: string | undefined;
  let longLink: string | undefined;
  for (;;) {
    const block = await bytes.exact(BLOCK);
    if (block.every((byte) => byte === 0)) {
      if (!(await bytes.exact(BLOCK)).every((byte) => byte === 0)) throw new Error("Tangle workspace archive has a malformed end marker");
      for await (const tail of bytes.rest()) {
        if (!tail.every((byte) => byte === 0)) throw new Error("Tangle workspace archive has data after its end marker");
      }
      if (pax || longName !== undefined || longLink !== undefined) throw new Error("Tangle workspace archive ends inside a member");
      return;
    }
    verifyChecksum(block);
    const magic = text(block, 257, 6);
    if (magic !== "ustar" && magic !== "ustar ") throw new Error("Tangle workspace archive has an unknown header format");
    const flag = String.fromCharCode(block[156]!);
    const headerSize = number(block, 124, 12);
    if (flag === "x" || flag === "L" || flag === "K") {
      if (headerSize > MAX_METADATA_BYTES) throw new Error("Tangle workspace archive metadata record is too large");
      const record = await bytes.exact(headerSize);
      await bytes.exact(padding(headerSize));
      if (flag === "x") pax = paxRecords(record);
      else if (flag === "L") longName = text(record, 0, record.byteLength);
      else longLink = text(record, 0, record.byteLength);
      continue;
    }
    if (flag === "g") throw new Error("Tangle workspace archive has an unsupported global header");
    const type = flag === "0" || flag === "\0" || flag === "7" ? "file"
      : flag === "5" ? "directory" : flag === "2" ? "symlink" : flag === "1" ? "link" : undefined;
    if (!type) throw new Error("Tangle workspace contains an unsupported file type");
    // The POSIX prefix field holds GNU-only data in an old-GNU ("ustar  ") header.
    const prefix = magic === "ustar" ? text(block, 345, 155) : "";
    const headerName = prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100);
    let name = pax?.get("path") ?? longName ?? headerName;
    if (type === "directory") name = name.replace(/\/$/, "");
    const size = paxNumber(pax?.get("size"), headerSize, true);
    if (type !== "file" && size !== 0) throw new Error("Tangle workspace archive gives a non-file member a body");
    const member = {
      name,
      type,
      size,
      mode: number(block, 100, 8) & 0o7777,
      uid: paxNumber(pax?.get("uid"), number(block, 108, 8), true),
      gid: paxNumber(pax?.get("gid"), number(block, 116, 8), true),
      mtime: paxNumber(pax?.get("mtime"), number(block, 136, 12), false),
      linkName: pax?.get("linkpath") ?? longLink ?? text(block, 157, 100),
    } as const;
    pax = undefined;
    longName = undefined;
    longLink = undefined;
    // The count lives outside the generator, so a consumer that stops early still leaves the
    // reader able to skip exactly the unread rest of the body.
    let left = size;
    const body = (async function* () {
      while (left > 0) {
        const piece = await bytes.next(left);
        left -= piece.byteLength;
        yield piece;
      }
    })();
    yield { ...member, body };
    for await (const _ of bytes.span(left)) { /* discard */ }
    await bytes.exact(padding(size));
  }
}
