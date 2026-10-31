import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isRecord } from '@tangle-network/agent-core'
import { SessionBuilder, count, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, Part, ReadOptions, SessionRef, TokenUsage } from '../schema.js'
import { withSqlite } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, walkFiles } from '../stores.js'
const FORMAT = 'openclaw.session-jsonl' as const
const STORE = STORES[FORMAT]
const HARNESS = 'openclaw'
const TOOL_CALL = new Set(['toolCall', 'toolUse', 'functionCall'])
function usageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  return usageOrNull({ input: count(value.input), output: count(value.output), reasoning: count(value.reasoning), cacheRead: count(value.cacheRead), cacheWrite: count(value.cacheWrite) })
}
function decode(json: unknown, zstd: unknown): Record<string, unknown> | null {
  const text = typeof json === 'string' && json ? json : zstd instanceof Uint8Array ? zstdDecompressSync(zstd).toString('utf8') : null
  if (!text) return null
  try { const value = JSON.parse(text) as unknown; return isRecord(value) ? value : null } catch { return null }
}
function readDb(db: DatabaseSync, sessionId: string, builder: SessionBuilder): void {
  const rows = db.prepare('SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq').all(sessionId) as { event_json: string | null; event_zstd: Uint8Array | null }[]
  let calls = 0
  for (const row of rows) {
    const event = decode(row.event_json, row.event_zstd)
    if (!event || event.type !== 'message' || !isRecord(event.message)) continue
    const message = event.message
    const role = str(message.role)
    const at = builder.seen(event.timestamp)
    const id = str(event.id) ?? `${sessionId}:${calls}`
    const text = textOf(message.content) ?? str(message.content)
    if (role === 'user' && text) { builder.message({ id, role: 'user', actor: 'human', at, modelCallId: null, parts: [{ type: 'text', text }] }); continue }
    if (role === 'toolResult') {
      const callId = str(message.toolCallId) ?? str(message.toolUseId) ?? id
      builder.toolResult(callId, { output: message.content ?? null, text, isError: message.isError === true, at, messageId: id })
      builder.message({ id, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: callId }] })
      continue
    }
    if (role !== 'assistant') continue
    const model = str(message.responseModel) ?? str(message.model)
    const modelCallId = `${sessionId}:${calls}`
    builder.modelCall({ id: modelCallId, at, provider: str(message.provider), servedModel: model, requestedModel: str(message.model), usage: usageOf(message.usage), costUsd: null, stopReason: str(message.stopReason), error: null })
    calls += 1
    const parts: Part[] = text ? [{ type: 'text', text }] : []
    if (Array.isArray(message.content)) for (const block of message.content) {
      if (!isRecord(block) || typeof block.type !== 'string' || !TOOL_CALL.has(block.type)) continue
      const callId = str(block.id) ?? `${modelCallId}:call`
      const input = block.arguments ?? block.input ?? null
      parts.push({ type: 'tool-call', toolCallId: callId })
      builder.toolCall({ id: callId, name: str(block.name) ?? 'tool', input, inputText: typeof input === 'string' ? input : null, at, messageId: id })
    }
    builder.message({ id, role: 'assistant', actor: 'agent', at, modelCallId, parts })
  }
}
export async function openclawSessionsInStore(path: string): Promise<SessionRef[]> {
  const refs: SessionRef[] = []
  await withSqlite(path, (db) => {
    for (const row of db.prepare('SELECT session_id FROM session_windows').all() as { session_id: string }[])
      refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: row.session_id, path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null })
  }).catch(() => undefined)
  return refs
}
async function fold(ref: SessionRef, mode: BuildMode): Promise<SessionBuilder> {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  await withSqlite(ref.path, (db) => readDb(db, ref.nativeSessionId, builder))
  builder.inferEnding()
  return builder
}
export const openclawReader: HarnessSessionReader = {
  harness: HARNESS, aliases: [], formats: [FORMAT], stores: [STORE], globs: { session: STORE.files[0] }, evidence: EVIDENCE[FORMAT],
  async locate(home, opts = {}) {
    const refs: SessionRef[] = []
    for (const rel of await walkFiles(join(home, STORE.root))) {
      if (!rel.endsWith('openclaw-agent.sqlite')) continue
      const path = join(home, STORE.root, rel)
      const mtime = await mtimeMs(path)
      for (const ref of await openclawSessionsInStore(path)) {
        if (opts.nativeSessionId && ref.nativeSessionId !== opts.nativeSessionId) continue
        refs.push({ ...ref, home, mtimeMs: mtime })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  },
  async read(ref, _opts: ReadOptions = {}) { return (await fold(ref, 'full')).build() },
  async summarize(ref, _opts: ReadOptions = {}) { return (await fold(ref, 'summary')).summary() },
}
