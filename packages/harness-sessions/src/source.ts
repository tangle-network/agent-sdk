import { createHash } from 'node:crypto'
import { createReadStream, rmSync } from 'node:fs'
import { copyFile, mkdtemp, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/** What one source file contributed to a read: its identity and what could not be parsed. */
export interface SourceStats {
  path: string
  sha256: string
  bytes: number
  unparsed: number
  /** The file ended without a newline and its last bytes were not a complete record. */
  tornTail: boolean
  /** The line number (1-based) of the record most recently yielded. */
  line: number
}

/** Records to fold, with the stats of the bytes they came from. */
export interface RecordSource {
  stats: SourceStats
  records: AsyncIterable<Record<string, unknown>>
}

export class SessionParseError extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    reason: string,
  ) {
    super(`${path}:${line}: ${reason}`)
    this.name = 'SessionParseError'
  }
}

const NEWLINE = 0x0a

/**
 * Streams the JSON records of one append-only JSONL file. Each record is parsed and yielded in
 * order; the whole file is hashed as it is read. An unparsable line is counted (or thrown in
 * strict mode). A final line without a newline that does not parse is a record the harness was
 * still writing when the copy was taken, so it is reported as a torn tail rather than corruption.
 */
export async function* readJsonlRecords(
  path: string,
  stats: SourceStats,
  options: { strict?: boolean; signal?: AbortSignal } = {},
): AsyncGenerator<Record<string, unknown>> {
  const hash = createHash('sha256')
  let pending: Buffer[] = []
  let pendingBytes = 0
  let lineNumber = 0

  const parse = (bytes: Buffer, terminated: boolean): Record<string, unknown> | undefined => {
    lineNumber += 1
    const text = bytes.toString('utf8').replace(/\r$/u, '')
    if (text.trim().length === 0) return undefined
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      if (!terminated) {
        stats.tornTail = true
        return undefined
      }
      if (options.strict) throw new SessionParseError(path, lineNumber, 'malformed JSON')
      stats.unparsed += 1
      return undefined
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      if (options.strict) throw new SessionParseError(path, lineNumber, 'record is not a JSON object')
      stats.unparsed += 1
      return undefined
    }
    return value as Record<string, unknown>
  }

  const stream = createReadStream(path, { highWaterMark: 1 << 20, signal: options.signal })
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk)
    stats.bytes += chunk.length
    let start = 0
    for (;;) {
      const index = chunk.indexOf(NEWLINE, start)
      if (index === -1) break
      let line: Buffer
      if (pendingBytes > 0) {
        pending.push(chunk.subarray(start, index))
        line = Buffer.concat(pending)
        pending = []
        pendingBytes = 0
      } else {
        line = chunk.subarray(start, index)
      }
      const record = parse(line, true)
      if (record !== undefined) {
        stats.line = lineNumber
        yield record
      }
      start = index + 1
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start))
      pendingBytes += chunk.length - start
    }
  }
  if (pendingBytes > 0) {
    const record = parse(Buffer.concat(pending), false)
    if (record !== undefined) {
      stats.line = lineNumber
      yield record
    }
  }
  stats.sha256 = `sha256:${hash.digest('hex')}`
}

export function newSourceStats(path: string): SourceStats {
  return { path, sha256: '', bytes: 0, unparsed: 0, tornTail: false, line: 0 }
}

/** The records of a JSONL file, streamed. */
export function fileRecords(path: string, options: { strict?: boolean; signal?: AbortSignal } = {}): RecordSource {
  const stats = newSourceStats(path)
  return { stats, records: readJsonlRecords(path, stats, options) }
}

/** Stats for bytes already in memory. */
export function memoryStats(label: string, text?: string): SourceStats {
  if (text === undefined) return { path: label, sha256: '', bytes: 0, unparsed: 0, tornTail: false, line: 0 }
  const bytes = Buffer.from(text, 'utf8')
  return { path: label, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length, unparsed: 0, tornTail: false, line: 0 }
}

/** The records of JSONL text already in memory (a retained copy, a blob), read synchronously. */
export function* textRecordsSync(text: string, stats: SourceStats, options: { strict?: boolean } = {}): Generator<Record<string, unknown>> {
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/u, '')
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      if (index === lines.length - 1) {
        stats.tornTail = true
        continue
      }
      if (options.strict) throw new SessionParseError(stats.path, index + 1, 'malformed JSON')
      stats.unparsed += 1
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      if (options.strict) throw new SessionParseError(stats.path, index + 1, 'record is not a JSON object')
      stats.unparsed += 1
      continue
    }
    stats.line = index + 1
    yield value as Record<string, unknown>
  }
}

/** Records a caller already parsed (one per line, in order). Non-objects count as unparsed. */
export function* arrayRecordsSync(values: readonly unknown[], stats: SourceStats): Generator<Record<string, unknown>> {
  for (const [index, value] of values.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      stats.unparsed += 1
      continue
    }
    stats.line = index + 1
    yield value as Record<string, unknown>
  }
}

/** Hash a file without parsing it. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: `sha256:${hash.digest('hex')}`, bytes }
}

// `node:sqlite` is loaded through `createRequire`: bundlers rewrite a dynamic `import()` of a
// `node:` builtin under some targets, and a require obtained this way is not analyzable by them.
function loadSqlite(): typeof import('node:sqlite') {
  const nodeRequire = createRequire(import.meta.url)
  return nodeRequire('node:sqlite') as typeof import('node:sqlite')
}

interface StoreCopy {
  key: string
  dir: string
  db: DatabaseSync
  sources: Array<{ path: string; sha256: string; bytes: number }>
}

// One private copy is kept per process: reading every session of one store (a 4 GB opencode.db
// holding 26 sessions) copies it once, not once per session. It is replaced when a different
// store, or a store that changed, is read, and removed when the process exits.
let current: StoreCopy | null = null

function dropCopy(): void {
  if (current === null) return
  try {
    current.db.close()
  } catch {
    // already closed
  }
  rmSync(current.dir, { recursive: true, force: true })
  current = null
}
process.once('exit', dropCopy)

async function storeKey(path: string): Promise<string> {
  const parts: string[] = []
  for (const suffix of ['', '-wal']) {
    try {
      const s = await stat(`${path}${suffix}`)
      parts.push(`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`)
    } catch (error) {
      if (suffix === '' || !isMissing(error)) throw error
      parts.push('-')
    }
  }
  return `${path}|${parts.join('|')}`
}

/**
 * Run `use` against a private copy of a SQLite store. Opening a live store can checkpoint its
 * write-ahead log and change the bytes a capture is keeping, so the store and its -wal and -shm
 * siblings are copied first and only the copy is opened. `use` is synchronous so no other read can
 * replace the copy while it runs.
 */
export async function withSqliteCopy<T>(
  path: string,
  use: (db: DatabaseSync, sources: Array<{ path: string; sha256: string; bytes: number }>) => T,
): Promise<T> {
  const key = await storeKey(path)
  if (current?.key !== key) {
    const { DatabaseSync } = loadSqlite()
    const dir = await mkdtemp(join(tmpdir(), 'harness-sessions-sqlite-'))
    try {
      const sources: Array<{ path: string; sha256: string; bytes: number }> = []
      for (const suffix of ['', '-wal', '-shm']) {
        const copy = join(dir, `store.db${suffix}`)
        try {
          await copyFile(`${path}${suffix}`, copy)
        } catch (error) {
          if (suffix === '' || !isMissing(error)) throw error
          continue
        }
        // The shared-memory index is rebuilt from the WAL; only the store and its log carry data.
        if (suffix !== '-shm') sources.push({ path: `${path}${suffix}`, ...(await hashFile(copy)) })
      }
      // Opened writable so SQLite replays the copied write-ahead log into the private copy.
      const db = new DatabaseSync(join(dir, 'store.db'))
      dropCopy()
      current = { key, dir, db, sources }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }
  return use(current!.db, current!.sources)
}

/** Remove the private store copy now instead of at process exit. */
export function releaseSqliteCopy(): void {
  dropCopy()
}

export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
