import { foldedReader } from './fold.js'
import { basename, dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { SessionBuilder, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, SessionRef } from '../schema.js'
import { isMissing, sqliteStoreFiles, withSqlite } from '../source.js'
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
  try { await withSqlite(join(dir, 'inbound.db'), db => readTable(db, 'messages_in', 'user', builder)) }
  catch (error) { if (!isMissing(error)) throw error }
  await withSqlite(join(dir, 'outbound.db'), (db) => readTable(db, 'messages_out', 'assistant', builder))
  builder.inferEnding()
  return builder
}

async function sessionRefs(path: string, nativeSessionId?: string): Promise<SessionRef[]> {
  const dir = dirname(path)
  const outbound = join(dir, 'outbound.db')
  const inbound = join(dir, 'inbound.db')
  const ref = nanoclawRefForFile(outbound)
  if (nativeSessionId !== undefined && nativeSessionId !== ref.nativeSessionId) return []
  if (path === inbound) await withSqlite(outbound, db => db.prepare('SELECT seq, kind, content FROM messages_out LIMIT 0').all())
  const files = await sqliteStoreFiles(outbound)
  try {
    if ((await stat(inbound)).isFile()) {
      if (path !== inbound) await withSqlite(inbound, db => db.prepare('SELECT seq, kind, content FROM messages_in LIMIT 0').all())
      files.push(...await sqliteStoreFiles(inbound))
    }
  } catch (error) { if (!isMissing(error)) throw error }
  return [{ ...ref, files, mtimeMs: await mtimeMs(outbound) }]
}

export const nanoclawReader: HarnessSessionReader = foldedReader({ harness: HARNESS, aliases: [], format: FORMAT,
  sqlite: {
    matches: (has, path) => (basename(path) === 'outbound.db' && has('messages_out', 'seq') && has('messages_out', 'content'))
      || (basename(path) === 'inbound.db' && has('messages_in', 'seq') && has('messages_in', 'content')),
    sessions: (path, opts) => sessionRefs(path, opts.nativeSessionId),
  },
}, async (home, opts) => {
  const root = join(home, STORE.root)
  const pattern = storeGlob(STORE.files[0], opts.nativeSessionId)
  const refs: SessionRef[] = []
  for (const rel of await walkFiles(root)) {
    if (!pattern.test(rel)) continue
    const path = join(root, rel)
    for (const ref of await sessionRefs(path, opts.nativeSessionId)) {
      if (!opts.sinceMs || ref.mtimeMs >= opts.sinceMs) refs.push({ ...ref, home })
    }
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}, fold)

export function nanoclawRefForFile(path: string): SessionRef {
  return { harness: HARNESS, format: FORMAT, nativeSessionId: basename(dirname(path)), path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null }
}
