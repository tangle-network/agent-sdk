import { foldedReader } from './fold.js'
import { isRecord } from '@tangle-network/agent-core'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { BOUND_HARNESS_SESSION_READ_LIMITS } from '../bounded-family.js'
import { SessionBuilder, count, isoTime, sessionError, str, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, LocateOptions, ModelCall, Part, ReadOptions, SessionError, SessionRef, TokenUsage } from '../schema.js'
import { isMissing, withSqlite, withSqliteBytes, withSqliteReadSnapshot } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, withinPath } from '../stores.js'
import { foldSessionV2, hasOpenCodeV2Schema } from './opencode-v2.js'

const FORMAT = 'opencode.sqlite' as const
const STORE = STORES[FORMAT]
const HARNESS = 'opencode'

function usageOf(tokens: unknown): TokenUsage | null {
  if (!isRecord(tokens)) return null
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  return usageOrNull({
    input: count(tokens.input),
    output: count(tokens.output),
    reasoning: count(tokens.reasoning),
    cacheRead: count(cache.read),
    cacheWrite: count(cache.write),
  })
}

function errorOf(value: unknown, at: string | null): SessionError | null {
  if (!isRecord(value)) return null
  const data = isRecord(value.data) ? value.data : {}
  const name = str(value.name) ?? 'error'
  return sessionError(name, str(data.message) ?? str(value.message) ?? name, at, count(data.statusCode))
}

function parse(json: unknown): Record<string, unknown> | null {
  if (typeof json !== 'string') return null
  try {
    const value: unknown = JSON.parse(json)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

interface Row {
  id: string
  data: string
  time_created: number
}

function foldSession(db: DatabaseSync, ref: SessionRef, mode: BuildMode, builder: SessionBuilder): void {
  const session = db.prepare('SELECT id, parent_id, directory, time_created, time_updated FROM session WHERE id = ?').get(ref.nativeSessionId) as
    | { id: string; parent_id: string | null; directory: string; time_created: number; time_updated: number }
    | undefined
  if (!session) {
    builder.gap(`session ${ref.nativeSessionId} is not in the store`)
    return
  }
  builder.cwd = session.directory
  builder.parentNativeSessionId = session.parent_id ?? null
  builder.seen(session.time_created)

  const digest = createHash('sha256').update(JSON.stringify(session))
  let bytes = 0
  const note = (row: Row): void => {
    const data = String(row.data)
    digest.update(`\n${row.id}\t${row.time_created}\t`).update(data)
    bytes += Buffer.byteLength(data)
  }

  const messages = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(ref.nativeSessionId) as unknown as Row[]
  const partsOf = db.prepare('SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY id')
  let unparsed = 0
  let aborted: { at: string | null; error: SessionError | null } | null = null

  for (const row of messages) {
    note(row)
    const data = parse(row.data)
    if (data === null) {
      unparsed += 1
      continue
    }
    const time = isRecord(data.time) ? data.time : {}
    const at = builder.seen(time.created ?? row.time_created)
    builder.seen(time.completed)
    const parts: Array<{ id: string; data: Record<string, unknown> }> = []
    for (const partRow of partsOf.iterate(row.id) as Iterable<Row>) {
      note(partRow)
      const part = parse(partRow.data)
      if (part === null) unparsed += 1
      else parts.push({ id: partRow.id, data: part })
    }

    if (data.role === 'user') {
      aborted = null
      const content: Part[] = []
      let synthetic = parts.length > 0
      for (const { data: part } of parts) {
        if (part.type === 'text' && typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text })
          if (part.synthetic !== true) synthetic = false
        } else if (part.type === 'file') {
          content.push({ type: 'attachment', mediaType: str(part.mime) ?? 'file', ref: str(part.filename) ?? str(part.url)?.slice(0, 200) ?? row.id })
          synthetic = false
        }
      }
      builder.message({ id: row.id, role: 'user', actor: synthetic ? 'injected' : builder.parentNativeSessionId ? 'subagent-spawn' : 'human', at, modelCallId: null, parts: content })
      continue
    }
    if (data.role !== 'assistant') continue

    const provider = str(data.providerID)
    const model = str(data.modelID)
    const messageError = errorOf(data.error, isoTime(time.completed) ?? at)
    let step: { call: ModelCall; messageId: string } | null = null
    let steps = 0
    const startStep = (stepAt: string | null): { call: ModelCall; messageId: string } => {
      steps += 1
      const id = `${row.id}:step:${steps}`
      const call = builder.modelCall({ id, at: stepAt, provider, servedModel: model, requestedModel: model, usage: null, costUsd: null, stopReason: null, error: null })
      builder.message({ id, role: 'assistant', actor: 'agent', at: stepAt, modelCallId: id, parts: [] })
      return { call, messageId: id }
    }
    for (const { id: partId, data: part } of parts) {
      const partTime = isRecord(part.time) ? part.time : {}
      const partAt = builder.seen(partTime.start) ?? at
      switch (part.type) {
        case 'step-start':
          step = startStep(partAt)
          break
        case 'step-finish': {
          const current = step ?? startStep(partAt)
          current.call.usage = usageOf(part.tokens)
          current.call.costUsd = count(part.cost)
          current.call.stopReason = str(part.reason)
          step = null
          break
        }
        case 'text':
          if (typeof part.text === 'string') {
            const current = step ?? (step = startStep(partAt))
            builder.appendParts(current.messageId, [{ type: 'text', text: part.text }])
          }
          break
        case 'reasoning':
          if (typeof part.text === 'string') {
            const current = step ?? (step = startStep(partAt))
            builder.appendParts(current.messageId, [{ type: 'reasoning', text: part.text, redacted: false }])
          }
          break
        case 'tool': {
          const current = step ?? (step = startStep(partAt))
          const callId = str(part.callID) ?? partId
          const state = isRecord(part.state) ? part.state : {}
          const stateTime = isRecord(state.time) ? state.time : {}
          builder.appendParts(current.messageId, [{ type: 'tool-call', toolCallId: callId }])
          builder.toolCall({ id: callId, name: str(part.tool) ?? 'unknown', input: state.input ?? null, inputText: null, at: isoTime(stateTime.start) ?? partAt, messageId: current.messageId })
          if (state.status === 'completed' || state.status === 'error') {
            const endAt = builder.seen(stateTime.end) ?? partAt
            const output = state.status === 'error' ? (state.error ?? null) : (state.output ?? null)
            const resultId = `${callId}:result`
            builder.message({ id: resultId, role: 'tool', actor: 'tool-result', at: endAt, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: callId }] })
            builder.toolResult(callId, { output, text: typeof output === 'string' ? output : null, isError: state.status === 'error', at: endAt, messageId: resultId, details: state.metadata ?? null })
          }
          const metadata = isRecord(state.metadata) ? state.metadata : {}
          const childId = str(metadata.sessionId)
          if (childId) builder.child(childId, callId)
          break
        }
        case 'retry': {
          builder.modelCall({ id: `${row.id}:retry:${partId}`, at: isoTime(partTime.created) ?? partAt, provider, servedModel: null, requestedModel: model, usage: null, costUsd: null, stopReason: null, error: errorOf(part.error, partAt) ?? sessionError('retry', 'retried request', partAt) })
          break
        }
        default:
          break
      }
    }
    if (steps === 0) {
      // Pending requests have zero defaults; a live fork can copy measured counters before its parts.
      const observed = messageError === null && isoTime(time.completed) !== null && str(data.finish) !== null
      const usage = usageOf(data.tokens), costUsd = count(data.cost)
      const accounted = observed || (costUsd ?? 0) > 0 || Object.values(usage ?? {}).some(value => (value ?? 0) > 0)
      builder.modelCall({ id: `${row.id}:request`, at, provider: observed ? provider : null, servedModel: observed ? model : null, requestedModel: model, usage: accounted ? usage : null, costUsd: accounted ? costUsd : null, stopReason: str(data.finish), error: messageError })
      if (messageError) builder.message({ id: row.id, role: 'assistant', actor: 'injected', at, modelCallId: `${row.id}:request`, parts: [{ type: 'text', text: messageError.message }] })
    } else if (messageError) builder.modelCalls[builder.modelCalls.length - 1]!.error = messageError
    aborted = messageError?.kind === 'MessageAbortedError' ? { at: messageError.at, error: messageError } : null
  }

  const children = db.prepare('SELECT id FROM session WHERE parent_id = ? ORDER BY time_created, id').all(ref.nativeSessionId) as Array<{ id: string }>
  for (const child of children) {
    digest.update(`\n${child.id}`)
    builder.child(child.id, null)
  }
  builder.source({ path: `${ref.path}#session=${ref.nativeSessionId}`, sha256: `sha256:${digest.digest('hex')}`, bytes, unparsed })
  const last = builder.modelCalls[builder.modelCalls.length - 1]
  if (aborted && last?.error?.kind === 'MessageAbortedError') last.error = null
  builder.inferEnding(aborted ?? undefined)
}

async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions): Promise<SessionBuilder> {
  options.signal?.throwIfAborted()
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  await withSqlite(ref.path, (db) => {
    if (hasOpenCodeV2Schema(db)) foldSessionV2(db, ref, mode, builder)
    else foldSession(db, ref, mode, builder)
  })
  if (ref.truncated) builder.markTruncated(`${ref.path}: the store copy was cut short`)
  return builder
}

export async function opencodeSessionsInStore(path: string, home: string | null, opts: LocateOptions = {}): Promise<SessionRef[]> {
  const mtime = await mtimeMs(path)
  const files = [path]
  for (const suffix of ['-wal', '-shm']) if ((await mtimeMs(`${path}${suffix}`)) > 0) files.push(`${path}${suffix}`)
  return withSqlite(path, (db) => {
    const table = hasOpenCodeV2Schema(db) ? 'session_v2' : 'session'
    const rows = db.prepare(`SELECT id, parent_id, directory, time_updated FROM ${table} ORDER BY time_updated DESC`).all() as Array<{ id: string; parent_id: string | null; directory: string; time_updated: number }>
    return rows
      .filter((row) => (!opts.nativeSessionId || row.id === opts.nativeSessionId)
        && (!opts.cwd || withinPath(row.directory, opts.cwd))
        && (!opts.sinceMs || row.time_updated >= opts.sinceMs))
      .map((row) => ({ harness: HARNESS, format: FORMAT, nativeSessionId: row.id, path, files, home, cwd: row.directory, mtimeMs: row.time_updated || mtime, parentNativeSessionId: row.parent_id }))
  })
}

/** Capture only the selected native conversations and their recorded descendants.
 * OpenCode 2 stores account credentials in the same database: never copy its whole store.
 * The host owns authorization and confinement of `path`. SQLite owns the consistent WAL view. */
export async function captureOpenCodeSessionStore(path: string, nativeSessionIds: readonly string[], options: ReadOptions = {}): Promise<{ bytes: Uint8Array; nativeSessionIds: string[] }> {
  options.signal?.throwIfAborted()
  const limits = BOUND_HARNESS_SESSION_READ_LIMITS
  if (!nativeSessionIds.length || nativeSessionIds.length > limits.maxFiles || nativeSessionIds.some(id => !id) || new Set(nativeSessionIds).size !== nativeSessionIds.length)
    throw new Error('OpenCode capture requires unambiguous native session identities')
  const { DatabaseSync } = await import('node:sqlite')
  const dir = await mkdtemp(join(tmpdir(), 'harness-sessions-opencode-'))
  const capturedPath = join(dir, 'sessions.db')
  let captured: DatabaseSync | undefined
  try {
    captured = new DatabaseSync(capturedPath)
    const target = captured
    const retained = await withSqliteReadSnapshot(path, (source) => {
      const v2 = hasOpenCodeV2Schema(source)
      const tables = v2 ? ['session_v2', 'session_message', 'session_part'] : ['session', 'message', 'part']
      const columns = v2 ? [
        'id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_busy INTEGER, time_idle INTEGER, idle_outcome TEXT, model TEXT, agent TEXT',
        'id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT',
        'message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT',
      ] : [
        'id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER',
        'id TEXT, session_id TEXT, time_created INTEGER, data TEXT',
        'id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT',
      ]
      const names = columns.map(definition => definition.split(', ').map(column => column.split(' ')[0]!))
      target.exec('BEGIN')
      for (const [index, table] of tables.entries()) target.exec(`CREATE TABLE ${table} (${columns[index]})`)
      const inserts = tables.map((table, index) => target.prepare(`INSERT INTO ${table} VALUES (${names[index]!.map(() => '?').join(',')})`))
      const queries = tables.map((table, index) => source.prepare(`SELECT ${names[index]!.join(',')} FROM ${table} WHERE ${index === 0 ? 'id' : 'session_id'} = ?`))
      const descendants = source.prepare(`SELECT id FROM ${tables[0]} WHERE parent_id = ? ORDER BY time_created, id`)
      const pending = [...nativeSessionIds], seen = new Set<string>()
      let bytes = 0
      while (pending.length) {
        options.signal?.throwIfAborted()
        const id = pending.shift()!
        if (seen.has(id)) continue
        if (seen.size >= limits.maxFiles) throw new Error('OpenCode native family exceeds the capture bound')
        const row = queries[0]!.get(id)
        if (!row) throw new Error('The exact OpenCode native session was not found')
        seen.add(id)
        for (const [index, query] of queries.entries()) {
          for (const record of index === 0 ? [row] : query.iterate(id)) {
            options.signal?.throwIfAborted()
            const values = names[index]!.map(name => record[name]!)
            bytes += values.reduce<number>((total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : 8), 0)
            if (bytes > limits.maxFileBytes) throw new Error('OpenCode native bytes exceed the capture bound')
            inserts[index]!.run(...values)
          }
        }
        for (const child of descendants.iterate(id)) pending.push(String(child.id))
      }
      target.exec('COMMIT')
      return [...seen]
    })
    captured.close()
    captured = undefined
    options.signal?.throwIfAborted()
    const bytes = await readFile(capturedPath, { signal: options.signal })
    if (bytes.length > limits.maxFileBytes) throw new Error('OpenCode native bytes exceed the capture bound')
    return { bytes, nativeSessionIds: retained }
  } finally {
    captured?.close()
    await rm(dir, { recursive: true, force: true })
  }
}

/** Read an immutable session-only capture through the same native format fold. */
export async function readOpenCodeSessionSnapshot(bytes: Uint8Array, nativeSessionId: string, options: ReadOptions & { label?: string } = {}) {
  if (!nativeSessionId || bytes.byteLength > BOUND_HARNESS_SESSION_READ_LIMITS.maxFileBytes)
    throw new Error('OpenCode snapshot identity or size is invalid')
  const ref: SessionRef = {
    harness: HARNESS, format: FORMAT, nativeSessionId, parentNativeSessionId: null,
    path: options.label ?? `opencode:${nativeSessionId}`, files: [], home: null, cwd: null, mtimeMs: 0,
  }
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, 'full', nativeSessionId, null)
  await withSqliteBytes(bytes, (db) => {
    const v2 = hasOpenCodeV2Schema(db)
    const allowed = new Set(v2 ? ['session_v2', 'session_message', 'session_part'] : ['session', 'message', 'part'])
    const schema = db.prepare("SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all()
    if (schema.length !== 3 || schema.some(row => row.type !== 'table' || !allowed.has(String(row.name))))
      throw new Error('OpenCode capture must contain only its native session tables')
    if (v2) foldSessionV2(db, ref, 'full', builder)
    else foldSession(db, ref, 'full', builder)
  }, options.signal)
  return builder.build()
}

export const opencodeReader: HarnessSessionReader = foldedReader({ harness: HARNESS, aliases: ['opencode-acp', 'opencode-cli'], format: FORMAT }, async (home, opts) => {
  const path = join(home, STORE.root, STORE.files[0])
  try {
    return await opencodeSessionsInStore(path, home, opts)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}, fold)
