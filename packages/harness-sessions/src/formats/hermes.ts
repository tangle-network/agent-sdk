import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SessionBuilder, count, str, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, ReadOptions, SessionRef, TokenUsage } from '../schema.js'
import { withSqlite } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, walkFiles } from '../stores.js'

const FORMAT = 'hermes.state-sqlite' as const
const STORE = STORES[FORMAT]
const HARNESS = 'hermes'

function callsOf(raw: unknown): { id: string; name: string; input: unknown }[] {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!call || typeof call !== 'object') return []
    const row = call as { id?: unknown; name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const fn = row.function
    const id = str(row.id)
    const name = str(row.name) ?? str(fn?.name)
    if (!id || !name) return []
    return [{ id, name, input: row.arguments ?? fn?.arguments ?? null }]
  })
}

function readDb(db: DatabaseSync, sessionId: string, builder: SessionBuilder): TokenUsage | null {
  const session = db.prepare('SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at FROM sessions WHERE id = ?').get(sessionId) as { model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; started_at: number | null } | undefined
  const at = session ? builder.seen(session.started_at ? session.started_at * 1000 : null) : null
  const usage = session ? usageOrNull({ input: count(session.input_tokens), output: count(session.output_tokens), reasoning: null, cacheRead: count(session.cache_read_tokens), cacheWrite: count(session.cache_write_tokens) }) : null
  const model = session ? str(session.model) : null
  const rows = db.prepare('SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY id').all(sessionId) as { id: number; role: string; content: string | null; tool_call_id: string | null; tool_calls: string | null; tool_name: string | null; timestamp: number | null }[]
  let calls = 0
  for (const row of rows) {
    const when = builder.seen(row.timestamp ? row.timestamp * 1000 : null)
    const id = String(row.id)
    if (row.role === 'user' && row.content) builder.message({ id, role: 'user', actor: 'human', at: when, modelCallId: null, parts: [{ type: 'text', text: row.content }] })
    if (row.role === 'assistant') {
      const modelCallId = `${sessionId}:${calls}`
      builder.modelCall({ id: modelCallId, at: when ?? at, provider: null, servedModel: model, requestedModel: model, usage: calls === 0 ? usage : null, costUsd: null, stopReason: null, error: null })
      calls += 1
      for (const call of callsOf(row.tool_calls)) builder.toolCall({ id: call.id, name: call.name, input: call.input, inputText: null, at: when, messageId: id })
      if (row.content) builder.message({ id, role: 'assistant', actor: 'agent', at: when, modelCallId, parts: [{ type: 'text', text: row.content }] })
    }
    if (row.role === 'tool' && row.tool_call_id) builder.toolResult(row.tool_call_id, { output: row.content, text: row.content, isError: false, at: when, messageId: id })
  }
  return usage
}

async function fold(ref: SessionRef, mode: BuildMode): Promise<SessionBuilder> {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  await withSqlite(ref.path, (db) => readDb(db, ref.nativeSessionId, builder))
  builder.inferEnding()
  return builder
}

export async function hermesSessionsInStore(path: string): Promise<SessionRef[]> {
  const refs: SessionRef[] = []
  await withSqlite(path, (db) => {
    for (const row of db.prepare('SELECT id FROM sessions').all() as { id: string }[]) {
      refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: row.id, path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null })
    }
  }).catch(() => undefined)
  return refs
}

export const hermesReader: HarnessSessionReader = {
  harness: HARNESS, aliases: [], formats: [FORMAT], stores: [STORE], globs: { session: STORE.files[0] }, evidence: EVIDENCE[FORMAT],
  async locate(home, opts = {}) {
    const root = join(home, STORE.root)
    const refs: SessionRef[] = []
    for (const rel of await walkFiles(root)) {
      if (basename(rel) !== 'state.db') continue
      const path = join(root, rel)
      const mtime = await mtimeMs(path)
      for (const ref of await hermesSessionsInStore(path)) {
        if (opts.nativeSessionId && ref.nativeSessionId !== opts.nativeSessionId) continue
        refs.push({ ...ref, home, mtimeMs: mtime })
      }
    }
    return refs
  },
  async read(ref, _opts: ReadOptions = {}) { return (await fold(ref, 'full')).build() },
  async summarize(ref, _opts: ReadOptions = {}) { return (await fold(ref, 'summary')).summary() },
}
