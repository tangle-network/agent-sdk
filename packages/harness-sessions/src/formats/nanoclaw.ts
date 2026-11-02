import { foldedReader } from './fold.js'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SessionBuilder, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, SessionRef } from '../schema.js'
import { withSqlite } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'

const FORMAT = 'nanoclaw.session-sqlite' as const
const STORE = STORES[FORMAT]
const HARNESS = 'nanoclaw'

function textOf(content: string): string {
  try {
    const value = JSON.parse(content) as { text?: unknown }
    if (typeof value.text === 'string') return value.text
  } catch {
  }
  return content
}

function readTable(db: DatabaseSync, table: 'messages_in' | 'messages_out', role: 'user' | 'assistant', builder: SessionBuilder): void {
  const rows = db.prepare(`SELECT id, timestamp, content, kind FROM ${table} ORDER BY seq`).all() as { id: string; timestamp: string; content: string; kind: string }[]
  for (const row of rows) {
    if (row.kind === 'system') continue
    const text = textOf(row.content)
    if (!text) continue
    builder.message({ id: row.id, role, actor: role === 'user' ? 'human' : 'agent', at: builder.seen(row.timestamp), modelCallId: null, parts: [{ type: 'text', text }] })
  }
}

async function fold(ref: SessionRef, mode: BuildMode): Promise<SessionBuilder> {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  const dir = dirname(ref.path)
  await withSqlite(join(dir, 'inbound.db'), (db) => readTable(db, 'messages_in', 'user', builder)).catch(() => undefined)
  await withSqlite(join(dir, 'outbound.db'), (db) => readTable(db, 'messages_out', 'assistant', builder))
  builder.inferEnding()
  return builder
}

export const nanoclawReader: HarnessSessionReader = foldedReader({ harness: HARNESS, aliases: [], format: FORMAT }, async (home, opts) => {
  const root = join(home, STORE.root)
  const pattern = storeGlob(STORE.files[0], opts.nativeSessionId)
  const refs: SessionRef[] = []
  for (const rel of await walkFiles(root)) {
    if (!pattern.test(rel)) continue
    const path = join(root, rel)
    const id = basename(dirname(rel))
    const mtime = await mtimeMs(path)
    if ((opts.sinceMs && mtime < opts.sinceMs) || (opts.nativeSessionId && id !== opts.nativeSessionId)) continue
    refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path, join(dirname(path), 'inbound.db')], home, cwd: null, mtimeMs: mtime, parentNativeSessionId: null })
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}, fold)

export function nanoclawRefForFile(path: string): SessionRef {
  return { harness: HARNESS, format: FORMAT, nativeSessionId: basename(dirname(path)), path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null }
}
