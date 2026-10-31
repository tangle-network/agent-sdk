import { createHash } from 'node:crypto'
import { constants, rmSync } from 'node:fs'
import { copyFile, mkdtemp, open, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

export interface SourceStats {
  path: string
  sha256: string
  bytes: number
  unparsed: number
  tornTail: boolean
  line: number
  unparsedLines?: number[]
}

const MAX_UNPARSED_LINES = 50
function noteUnparsed(stats: SourceStats, line: number): void {
  stats.unparsed += 1
  stats.unparsedLines ??= []
  if (stats.unparsedLines.length < MAX_UNPARSED_LINES) stats.unparsedLines.push(line)
}

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

  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') throw new Error('Safe native JSONL reads require O_NOFOLLOW and O_NONBLOCK')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error(`${path}: native session must be a regular file`)
    const stream = file.createReadStream({ highWaterMark: 1 << 20, signal: options.signal, autoClose: false })
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
  } finally {
    await file.close()
  }
}

export function newSourceStats(path: string): SourceStats {
  return { path, sha256: '', bytes: 0, unparsed: 0, tornTail: false, line: 0 }
}

export function fileRecords(path: string, options: { strict?: boolean; signal?: AbortSignal } = {}): RecordSource {
  const stats = newSourceStats(path)
  return { stats, records: readJsonlRecords(path, stats, options) }
}

export function memoryStats(label: string, text?: string): SourceStats {
  if (text === undefined) return { path: label, sha256: '', bytes: 0, unparsed: 0, tornTail: false, line: 0 }
  const bytes = Buffer.from(text, 'utf8')
  return { path: label, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length, unparsed: 0, tornTail: false, line: 0 }
}

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

async function openSqlite(path: string): Promise<DatabaseSync> {
  const mode = (await exists(`${path}-wal`)) ? 'mode=ro' : 'immutable=1'
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(`${pathToFileURL(path).href}?${mode}`, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('PRAGMA schema_version').get()
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function cannotOpen(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | undefined)?.errcode
  return typeof code === 'number' && (code & 0xff) === 14
}

export async function withSqlite<T>(path: string, use: (db: DatabaseSync) => T): Promise<T> {
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

let current: StoreCopy | null = null

function dropCopy(): void {
  if (current === null) return
  try {
    current.db.close()
  } catch {
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
