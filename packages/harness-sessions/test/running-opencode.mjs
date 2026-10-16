// Stands in for a running OpenCode: opens the store at argv[2] writable, commits a child session
// (id argv[3]) of session argv[4] that stays in the write-ahead log, prints `ready`, and holds the
// store open until its stdin closes.
import { DatabaseSync } from 'node:sqlite'

const [store, childId, parentId] = process.argv.slice(2)
const db = new DatabaseSync(store)
db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
const columns = db.prepare('PRAGMA table_info(session)').all().map((column) => column.name)
const values = columns.map((name) => (name === 'id' ? '?' : name === 'parent_id' ? 'id' : name === 'time_updated' ? 'time_updated + 1' : name))
db.prepare(`INSERT INTO session (${columns.join(', ')}) SELECT ${values.join(', ')} FROM session WHERE id = ?`).run(childId, parentId)
process.stdout.write('ready\n')
process.stdin.on('end', () => db.close()).resume()
