import { isRecord } from '@tangle-network/agent-core'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SessionBuilder, argumentsOf, count, isoTime, sessionError, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { Part, SessionEnding, SessionError, SessionRef, TokenUsage } from '../schema.js'

export function hasOpenCodeV2Schema(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_v2'").get() !== undefined
}

function parse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try { const data: unknown = JSON.parse(value); return isRecord(data) ? data : null } catch { return null }
}

function usageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const cache = isRecord(value.cache) ? value.cache : {}
  // Upstream SessionUsage.tokens defaults every absent channel to zero, even after a step
  // finishes. The projection cannot distinguish those defaults from measured zero channels.
  const measured = (raw: unknown): number | null => { const n = count(raw); return n !== null && n > 0 ? n : null }
  return usageOrNull({ input: measured(value.input), output: measured(value.output), reasoning: measured(value.reasoning), cacheRead: measured(cache.read), cacheWrite: measured(cache.write) })
}

function errorOf(value: unknown, at: string | null): SessionError | null {
  if (!isRecord(value)) return null
  const kind = str(value.type) ?? 'error'
  return sessionError(kind, str(value.message) ?? kind, at, count(value.status))
}

interface SessionRow {
  id: string; parent_id: string | null; directory: string; time_created: number; time_updated: number
  time_busy: number | null; time_idle: number | null; idle_outcome: string | null
}
interface MessageRow { id: string; type: string; seq: number; time_created: number; time_updated: number; data: string }
interface PartRow { message_id: string; ordinal: number; type: string; call_id: string | null; time_created: number; time_updated: number; data: string }

/** OpenCode 2.3's native projection. Model.Ref is routing context, not a response model receipt.
 * See upstream v2.3.0 session/history.ts (parts before inline content) and schema/session-message.ts. */
export function foldSessionV2(db: DatabaseSync, ref: SessionRef, _mode: BuildMode, builder: SessionBuilder): void {
  const session = db.prepare('SELECT id, parent_id, directory, time_created, time_updated, time_busy, time_idle, idle_outcome FROM session_v2 WHERE id = ?').get(ref.nativeSessionId) as SessionRow | undefined
  if (!session) { builder.gap(`session ${ref.nativeSessionId} is not in the store`); return }
  builder.cwd = session.directory
  builder.parentNativeSessionId = session.parent_id
  builder.seen(session.time_created)
  const digest = createHash('sha256')
  let bytes = 0, unparsed = 0
  const note = (value: unknown): void => {
    const json = JSON.stringify(value)
    digest.update(json).update('\n')
    bytes += Buffer.byteLength(json) + 1
  }
  note(session)
  let ending: SessionEnding = { status: 'open', at: null, error: null }
  const open = (): void => { ending = { status: 'open', at: null, error: null } }
  const messages = db.prepare('SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq, id').all(ref.nativeSessionId) as unknown as MessageRow[]
  const partsOf = db.prepare('SELECT message_id, ordinal, type, call_id, time_created, time_updated, data FROM session_part WHERE session_id = ? AND message_id = ? ORDER BY ordinal')

  for (const row of messages) {
    note(row)
    const data = parse(row.data)
    if (!data) { unparsed++; open(); continue }
    const time = isRecord(data.time) ? data.time : {}
    const at = builder.seen(time.created ?? row.time_created)
    const completedAt = builder.seen(time.completed)
    if (row.type === 'idle') {
      const error = errorOf(data.error, at)
      if (data.outcome === 'succeeded') ending = { status: 'completed', at, error }
      else if (data.outcome === 'failed') ending = { status: 'error', at, error }
      else if (data.outcome === 'interrupted') ending = { status: 'aborted', at, error }
      else { builder.gap(`idle ${row.id} has no recognized outcome`); open() }
      continue
    }
    // Configuration changes alone do not start a new turn; every execution/input row does.
    if (row.type === 'agent-switched' || row.type === 'model-switched' || row.type === 'location-switched') continue
    open()
    if (['user', 'synthetic', 'system', 'skill'].includes(row.type)) {
      const parts: Part[] = typeof data.text === 'string' ? [{ type: 'text', text: data.text }] : []
      for (const file of Array.isArray(data.files) ? data.files : []) {
        if (!isRecord(file)) { unparsed++; continue }
        const source = isRecord(file.source) ? file.source : {}
        const mediaType = str(file.mime) ?? 'file'
        const attachment = str(file.uri) ?? (typeof file.data === 'string' ? `data:${mediaType};base64,${file.data}` : str(source.uri) ?? str(file.name))
        if (attachment) parts.push({ type: 'attachment', mediaType, ref: attachment })
        else builder.gap(`attachment in ${row.id} has no recorded bytes or reference`)
        if (attachment?.startsWith('media:')) builder.gap(`attachment ${attachment} is stored outside the captured session tables`)
      }
      builder.message({ id: row.id, role: row.type === 'system' ? 'system' : 'user', actor: row.type === 'user' ? (session.parent_id ? 'subagent-spawn' : 'human') : 'injected', at, modelCallId: null, parts, ...(row.type === 'user' ? {} : { source: row.type }) })
      continue
    }
    if (row.type === 'shell') {
      // This is an operator shell message, distinct from an assistant-issued shell tool call.
      const output = isRecord(data.output) ? data.output : {}
      builder.message({ id: row.id, role: 'user', actor: 'injected', at, modelCallId: null, source: 'shell', parts: [{ type: 'text', text: JSON.stringify({ command: data.command, status: data.status, exit: data.exit, output: output.output }) }] })
      if (output.truncated === true || (count(output.cursor) ?? 0) < (count(output.size) ?? 0)) builder.gap(`shell ${row.id} output is partial`)
      continue
    }
    if (row.type === 'compaction') {
      const model = isRecord(data.model) ? data.model : {}, error = errorOf(data.error, at)
      const usage = data.status === 'completed' || data.status === 'failed' ? usageOf(data.tokens) : null
      // Compaction usage belongs to its own request, never to the following assistant response.
      if (usage || str(model.id) || error) builder.modelCall({ id: row.id, at, provider: str(model.providerID), requestedModel: str(model.id), servedModel: null, usage, costUsd: null, stopReason: null, error })
      builder.message({ id: row.id, role: 'system', actor: 'injected', at, modelCallId: null, source: 'compaction', parts: typeof data.summary === 'string' ? [{ type: 'text', text: data.summary }] : [] })
      continue
    }
    if (row.type !== 'assistant') { builder.gap(`unrecognized OpenCode message type ${row.type}`); continue }

    const model = isRecord(data.model) ? data.model : {}
    const retry = isRecord(data.retry) ? data.retry : {}
    const error = errorOf(data.error, completedAt ?? at) ?? errorOf(retry.error, isoTime(retry.at) ?? at)
    const finish = str(data.finish)
    // step.started can reuse a row without clearing old tokens; step.failed can then mark it
    // complete without replacing them. The projection cannot prove fresh failed-attempt usage.
    const usage = completedAt && finish && finish !== 'error' && error === null ? usageOf(data.tokens) : null
    builder.modelCall({ id: row.id, at, provider: str(model.providerID), requestedModel: str(model.id), servedModel: null, usage, costUsd: null, stopReason: finish, error })
    if (data.retry) builder.gap(`assistant ${row.id} is retrying; earlier attempts are not separately retained`)

    // Upstream withParts prepends separately persisted parts, in ordinal order, to inline content.
    const content: unknown[] = []
    for (const partRow of partsOf.iterate(ref.nativeSessionId, row.id) as Iterable<PartRow>) {
      note(partRow)
      const part = parse(partRow.data)
      if (part) content.push({ ...part, type: partRow.type })
      else unparsed++
    }
    if (Array.isArray(data.content)) content.push(...data.content)
    else builder.gap(`assistant ${row.id} has no inline content array`)
    // A rejected/pending request with no content is an attempt, not an observed model reply.
    const replied = content.some(part => isRecord(part) && (part.type === 'tool' || ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string' && part.text.length > 0)))
    builder.message({ id: row.id, role: 'assistant', actor: replied ? 'agent' : 'injected', at, modelCallId: row.id, parts: [] })
    for (const part of content) {
      if (!isRecord(part)) { unparsed++; continue }
      if (part.type === 'text' && typeof part.text === 'string') builder.appendParts(row.id, [{ type: 'text', text: part.text }])
      else if (part.type === 'reasoning' && typeof part.text === 'string') builder.appendParts(row.id, [{ type: 'reasoning', text: part.text, redacted: false }])
      else if (part.type === 'tool') {
        const id = str(part.id), name = str(part.name)
        if (!id || !name) { builder.gap(`tool in ${row.id} has no native call identity or name`); continue }
        const state = isRecord(part.state) ? part.state : {}, toolTime = isRecord(part.time) ? part.time : {}
        const toolAt = builder.seen(toolTime.created) ?? at
        builder.appendParts(row.id, [{ type: 'tool-call', toolCallId: id }])
        builder.toolCall({ id, name, ...argumentsOf(state.input), at: toolAt, messageId: row.id })
        if (state.status === 'completed' || state.status === 'error') {
          const resultAt = builder.seen(toolTime.completed) ?? completedAt ?? toolAt
          const output = state.content ?? state.error ?? null
          const resultId = `${row.id}:tool:${id}:result`
          builder.message({ id: resultId, role: 'tool', actor: 'tool-result', at: resultAt, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: id }] })
          builder.toolResult(id, { output, text: textOf(state.content) ?? (isRecord(state.error) ? str(state.error.message) : null), isError: state.status === 'error', at: resultAt, messageId: resultId, details: state.metadata ?? null })
        }
        const metadata = isRecord(state.metadata) ? state.metadata : {}
        const child = str(metadata.sessionId) ?? str(metadata.sessionID)
        if (child) builder.child(child, id)
      } else { builder.gap(`unrecognized assistant content in ${row.id}`) }
    }
  }
  for (const child of db.prepare('SELECT id FROM session_v2 WHERE parent_id = ? ORDER BY time_created, id').all(ref.nativeSessionId) as Array<{ id: string }>) {
    note(child)
    builder.child(child.id, null)
  }
  // A resumed turn may not have appended its next message yet. Never reuse the previous idle marker.
  const busyAt = isoTime(session.time_busy)
  if (ending.at && busyAt && busyAt > ending.at) open()
  builder.source({ path: `${ref.path}#session=${ref.nativeSessionId}`, sha256: `sha256:${digest.digest('hex')}`, bytes, unparsed })
  builder.end(ending)
}
