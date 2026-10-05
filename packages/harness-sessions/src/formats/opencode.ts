/**
 * OpenCode 1.x: one SQLite store for every session in the HOME,
 * `~/.local/share/opencode/opencode.db` (with `-wal` and `-shm` siblings while it is open).
 *
 * `session` rows carry the cwd, the parent session and session totals. `message` rows carry a JSON
 * `data` blob: role, the provider and model the message was sent to, tokens, cost, finish and the
 * error that ended it. `part` rows carry the content: `text`, `reasoning`, `tool` (the call and
 * its result in one row), `step-start` and `step-finish` (one model response, with its tokens and
 * cost), `retry` (a failed attempt) and bookkeeping parts. The store is read from a private copy,
 * never in place: opening it can checkpoint the write-ahead log of a store a capture is keeping.
 */
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SessionBuilder, count, isRecord, isoTime, sessionError, str, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, LocateOptions, ModelCall, Part, ReadOptions, SessionError, SessionRef, TokenUsage } from '../schema.js'
import { isMissing, withSqliteCopy } from '../source.js'
import { EVIDENCE, STORES, mtimeMs } from '../stores.js'

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

  const messages = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(ref.nativeSessionId) as unknown as Row[]
  const partsOf = db.prepare('SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY id')
  let unparsed = 0
  let aborted: { at: string | null; error: SessionError | null } | null = null

  for (const row of messages) {
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
          // A failed request OpenCode retried: a model call that returned no answer.
          builder.modelCall({ id: `${row.id}:retry:${partId}`, at: isoTime(partTime.created) ?? partAt, provider, servedModel: null, requestedModel: model, usage: null, costUsd: null, stopReason: null, error: errorOf(part.error, partAt) ?? sessionError('retry', 'retried request', partAt) })
          break
        }
        default:
          break
      }
    }
    if (steps === 0) {
      // No response step was recorded: the request failed or the process stopped first.
      builder.modelCall({ id: `${row.id}:request`, at, provider: messageError ? null : provider, servedModel: messageError ? null : model, requestedModel: model, usage: usageOf(data.tokens), costUsd: count(data.cost), stopReason: str(data.finish), error: messageError })
      if (messageError) builder.message({ id: row.id, role: 'assistant', actor: 'injected', at, modelCallId: `${row.id}:request`, parts: [{ type: 'text', text: messageError.message }] })
    } else if (messageError) {
      const last = builder.modelCalls[builder.modelCalls.length - 1]!
      last.error = messageError
    }
    aborted = messageError?.kind === 'MessageAbortedError' ? { at: messageError.at, error: messageError } : null
  }

  const children = db.prepare('SELECT id FROM session WHERE parent_id = ? ORDER BY time_created, id').all(ref.nativeSessionId) as Array<{ id: string }>
  for (const child of children) builder.child(child.id, null)
  if (unparsed > 0) builder.source({ path: `${ref.path}#session=${ref.nativeSessionId}`, sha256: '', bytes: 0, unparsed })
  const last = builder.modelCalls[builder.modelCalls.length - 1]
  if (aborted && last?.error?.kind === 'MessageAbortedError') last.error = null
  builder.inferEnding(aborted ?? undefined)
}

async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions): Promise<SessionBuilder> {
  options.signal?.throwIfAborted()
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  await withSqliteCopy(ref.path, (db, sources) => {
    for (const source of sources) builder.source(source)
    foldSession(db, ref, mode, builder)
  })
  if (ref.truncated) builder.markTruncated(`${ref.path}: the store copy was cut short`)
  return builder
}

/** Every session in one store file, without opening the live store. */
export async function opencodeSessionsInStore(path: string, home: string | null, opts: LocateOptions = {}): Promise<SessionRef[]> {
  const mtime = await mtimeMs(path)
  const files = [path]
  for (const suffix of ['-wal', '-shm']) if ((await mtimeMs(`${path}${suffix}`)) > 0) files.push(`${path}${suffix}`)
  return withSqliteCopy(path, (db) => {
    const rows = db.prepare('SELECT id, parent_id, directory, time_updated FROM session ORDER BY time_updated DESC').all() as Array<{ id: string; parent_id: string | null; directory: string; time_updated: number }>
    return rows
      .filter((row) => (!opts.nativeSessionId || row.id === opts.nativeSessionId)
        && (!opts.cwd || row.directory.startsWith(opts.cwd))
        && (!opts.sinceMs || row.time_updated >= opts.sinceMs))
      .map((row) => ({ harness: HARNESS, format: FORMAT, nativeSessionId: row.id, path, files, home, cwd: row.directory, mtimeMs: row.time_updated || mtime, parentNativeSessionId: row.parent_id }))
  })
}

export const opencodeReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['opencode-acp', 'opencode-cli'],
  formats: [FORMAT],
  stores: [STORE],
  globs: { session: STORE.files[0] },
  evidence: EVIDENCE[FORMAT],
  async locate(home, opts = {}) {
    const path = join(home, STORE.root, STORE.files[0])
    try {
      return await opencodeSessionsInStore(path, home, opts)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  },
  async read(ref, opts = {}) {
    return (await fold(ref, 'full', opts)).build()
  },
  async summarize(ref, opts = {}) {
    return (await fold(ref, 'summary', opts)).summary()
  },
}
