import { createHash } from 'node:crypto'
import { createReadStream, rmSync } from 'node:fs'
import { copyFile, mkdtemp, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

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
  /** Line numbers of the first unparsable lines (at most 50), for the gaps a reader reports. */
  unparsedLines?: number[]
}

const MAX_UNPARSED_LINES = 50
function noteUnparsed(stats: SourceStats, line: number): void {
  stats.unparsed += 1
  stats.unparsedLines ??= []
  if (stats.unparsedLines.length < MAX_UNPARSED_LINES) stats.unparsedLines.push(line)
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
      noteUnparsed(stats, lineNumber)
      return undefined
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      if (options.strict) throw new SessionParseError(path, lineNumber, 'record is not a JSON object')
      noteUnparsed(stats, lineNumber)
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

/**
 * The records of JSONL text already in memory (a retained copy, a blob), read synchronously.
 * `firstLine` numbers the text's first line, for text that continues a longer file.
 */
export function* textRecordsSync(text: string, stats: SourceStats, options: { strict?: boolean; firstLine?: number } = {}): Generator<Record<string, unknown>> {
  const lines = text.split('\n')
  const first = options.firstLine ?? 1
  for (const [position, raw] of lines.entries()) {
    const index = first - 1 + position
    const line = raw.replace(/\r$/u, '')
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      if (position === lines.length - 1) {
        stats.tornTail = true
        continue
      }
      if (options.strict) throw new SessionParseError(stats.path, index + 1, 'malformed JSON')
      noteUnparsed(stats, index + 1)
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      if (options.strict) throw new SessionParseError(stats.path, index + 1, 'record is not a JSON object')
      noteUnparsed(stats, index + 1)
      continue
    }
    stats.line = index + 1
    yield value as Record<string, unknown>
  }
}

/** Records a caller already parsed (one per line, in order, the first on line `firstLine`). Non-objects count as unparsed. */
export function* arrayRecordsSync(values: readonly unknown[], stats: SourceStats, firstLine = 1): Generator<Record<string, unknown>> {
  for (const [position, value] of values.entries()) {
    const index = firstLine - 1 + position
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      noteUnparsed(stats, index + 1)
      continue
    }
    stats.line = index + 1
    yield value as Record<string, unknown>
  }
}

// `node:sqlite` is loaded through `createRequire`: bundlers rewrite a dynamic `import()` of a
// `node:` builtin under some targets, and a require obtained this way is not analyzable by them.
function loadSqlite(): typeof import('node:sqlite') {
  const nodeRequire = createRequire(import.meta.url)
  return nodeRequire('node:sqlite') as typeof import('node:sqlite')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * Open a SQLite store read-only where it lies. A store with a write-ahead log beside it is opened
 * `mode=ro`: SQLite reads the log's committed tail and coordinates with a live writer through the
 * store's shared-memory index (`-shm`), and never writes the store or its log or checkpoints it. A
 * store without a log is opened `immutable=1`: no connection holds it open, the file holds every
 * committed row, and SQLite creates no `-wal` or `-shm` beside it. Throws when SQLite cannot read
 * the store in place.
 */
async function openSqlite(path: string): Promise<DatabaseSync> {
  const mode = (await exists(`${path}-wal`)) ? 'mode=ro' : 'immutable=1'
  const { DatabaseSync } = loadSqlite()
  // `readOnly` as well: a Node that treated the URI as a file name would fail to open, not create it.
  const db = new DatabaseSync(`${pathToFileURL(path).href}?${mode}`, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    // The first read opens the log and its index, so a store SQLite cannot read in place fails here.
    db.prepare('PRAGMA schema_version').get()
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** SQLite's primary result code `SQLITE_CANTOPEN`, which `node:sqlite` errors carry in `errcode`. */
function cannotOpen(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | undefined)?.errcode
  return typeof code === 'number' && (code & 0xff) === 14
}

/**
 * Run `use` against a SQLite store opened read-only in place ({@link openSqlite}). A store SQLite
 * cannot open in place is read from a private copy instead: a write-ahead log with no `-shm` in a
 * directory SQLite cannot write (a capture on read-only storage), or a Node whose `node:sqlite`
 * does not accept URI file names (before 22.15).
 */
export async function withSqlite<T>(path: string, use: (db: DatabaseSync) => T): Promise<T> {
  // SQLite follows a symlinked store to its target and keeps the log there, so the log is looked
  // for there too. A missing store throws ENOENT here, which callers read as "no sessions".
  const store = await realpath(path)
  const db = await openSqlite(store).catch((error: unknown) => {
    if (cannotOpen(error)) return null
    throw error
  })
  if (db === null) return withSqliteCopy(store, use)
  try {
    return use(db)
  } finally {
    db.close()
  }
}

interface StoreCopy {
  key: string
  dir: string
  db: DatabaseSync
}

// One private copy is kept per process: reading every session of a store SQLite cannot open in
// place copies it once, not once per session. It is replaced when a different store, or a store
// that changed, is read, and removed when the process exits.
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
 * Run `use` against a private copy of a SQLite store: the store and its `-wal` and `-shm` siblings
 * are copied and only the copy is opened, writable, so SQLite replays the copied log into it. `use`
 * is synchronous so no other read can replace the copy while it runs.
 */
async function withSqliteCopy<T>(path: string, use: (db: DatabaseSync) => T): Promise<T> {
  const key = await storeKey(path)
  if (current?.key !== key) {
    const { DatabaseSync } = loadSqlite()
    const dir = await mkdtemp(join(tmpdir(), 'harness-sessions-sqlite-'))
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          await copyFile(`${path}${suffix}`, join(dir, `store.db${suffix}`))
        } catch (error) {
          if (suffix === '' || !isMissing(error)) throw error
        }
      }
      const db = new DatabaseSync(join(dir, 'store.db'))
      dropCopy()
      current = { key, dir, db }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }
  return use(current!.db)
}

export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
