/** A JSON array backed by a repeatable, bounded source rather than retained objects. */
export class EvidenceJsonArray {
  constructor(readonly count: number | undefined, readonly entries: () => AsyncIterable<unknown>) {}
}

/** JSON.stringify's wire form for plain JSON data, emitted without aggregate arrays. */
export async function* evidenceJsonChunks(value: unknown): AsyncIterable<Uint8Array> {
  const active = new Set<object>();
  async function* visit(item: unknown): AsyncIterable<Uint8Array> {
    if (item instanceof EvidenceJsonArray) {
      yield Buffer.from("[");
      let count = 0;
      for await (const entry of item.entries()) {
        if (count++ > 0) yield Buffer.from(",");
        yield* visit(entry);
      }
      if (item.count !== undefined && count !== item.count) throw new Error("Tangle evidence JSON record count changed");
      yield Buffer.from("]");
      return;
    }
    if (item !== null && typeof item === "object") {
      if (active.has(item)) throw new Error("Tangle evidence contains cyclic JSON");
      active.add(item);
      try {
        const array = Array.isArray(item);
        yield Buffer.from(array ? "[" : "{");
        let count = 0;
        if (array) {
          for (const entry of item) {
            if (count++ > 0) yield Buffer.from(",");
            yield* visit(entry);
          }
        } else {
          for (const [key, entry] of Object.entries(item)) {
            if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
            if (count++ > 0) yield Buffer.from(",");
            yield Buffer.from(JSON.stringify(key) + ":");
            yield* visit(entry);
          }
        }
        yield Buffer.from(array ? "]" : "}");
      } finally { active.delete(item); }
      return;
    }
    yield Buffer.from(JSON.stringify(item) ?? "null");
  }
  yield* visit(value);
}

/** Bound syscall and per-token allocation overhead without buffering the whole JSON value. */
export async function* coalesceEvidenceChunks(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let used = 0;
  for await (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const length = Math.min(buffer.byteLength - used, chunk.byteLength - offset);
      buffer.set(chunk.subarray(offset, offset + length), used);
      used += length;
      offset += length;
      if (used === buffer.byteLength) {
        yield Buffer.from(buffer);
        used = 0;
      }
    }
  }
  if (used) yield Buffer.from(buffer.subarray(0, used));
}
