import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { listReaders, readerFor } from './registry.js'
import type { SessionRef } from './schema.js'
import { withSqlite } from './source.js'

const signature = Buffer.from('SQLite format 3\0')

/** The file content identifies SQLite even when its name or enclosing store changed. */
export async function isNativeStoreDatabase(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const data = Buffer.alloc(signature.length)
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    return bytesRead === data.length && data.equals(signature)
  } finally { await file.close() }
}

/** Enumerate the owning reader's sessions. A foreign schema or absent ID has no matches. */
export async function nativeStoreSessions(path: string, options: { harness?: string; nativeSessionId?: string } = {}): Promise<SessionRef[]> {
  const target = resolve(path)
  const candidates = options.harness === undefined ? listReaders() : [readerFor(options.harness)]
  const matches = await withSqlite(target, (db) => {
    const columns = new Map<string, Set<string>>()
    const query = db.prepare('SELECT name FROM pragma_table_info(?)')
    function hasColumn(table: string, column: string): boolean {
      let names = columns.get(table)
      if (!names) {
        names = new Set(query.all(table).map(row => String(row.name)))
        columns.set(table, names)
      }
      return names.has(column)
    }
    return candidates.filter(reader => reader.sqlite?.matches(hasColumn, target))
  })
  if (matches.length > 1) throw new Error(`Multiple harness schemas in ${target}: ${matches.map(r => r.harness).join(', ')}. Select a harness.`)
  const store = matches[0]?.sqlite
  return store ? store.sessions(target, options) : []
}
