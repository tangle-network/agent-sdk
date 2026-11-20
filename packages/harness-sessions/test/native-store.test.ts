import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { isNativeStoreDatabase, nativeStoreSessions, readerFor } from '../src/index.js'

const scratch: string[] = []
const writers: DatabaseSync[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'native-store-'))
  scratch.push(path)
  return path
}

function liveDatabase(path: string, schema: string): DatabaseSync {
  const db = new DatabaseSync(path)
  writers.push(db)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
  db.exec(schema)
  return db
}

afterEach(() => {
  for (const db of writers.splice(0)) db.close()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('reads the exact native session from copied OpenCode, live Hermes and live OpenClaw databases regardless of filename', async () => {
  const dir = directory()
  const opencode = join(dir, 'state.db')
  copyFileSync(join(import.meta.dirname, 'fixtures/opencode/opencode.db'), opencode)
  const root = 'ses_ef7195eb2ffeZVueR3r0KnCUON'
  const [copied] = await nativeStoreSessions(opencode, { harness: 'opencode-acp', nativeSessionId: root })
  expect(copied?.harness).toBe('opencode')
  expect((await readerFor('opencode').read(copied!)).modelCalls).toHaveLength(3)
  expect(await nativeStoreSessions(opencode, { harness: 'hermes' })).toEqual([])

  const hermes = join(dir, 'opencode.db')
  const db = liveDatabase(hermes, `
    CREATE TABLE sessions(id TEXT PRIMARY KEY, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp);
    INSERT INTO sessions VALUES('chosen','recorded',1,2,0,0,100),('other','recorded',3,4,0,0,101);
    INSERT INTO messages VALUES(1,'chosen','assistant','Hermes response',NULL,NULL,NULL,100),(2,'other','user','Other session',NULL,NULL,NULL,101);
  `)
  for (const file of [opencode, hermes]) expect(await isNativeStoreDatabase(file)).toBe(true)
  const [picked] = await nativeStoreSessions(hermes, { nativeSessionId: 'chosen' })
  expect(picked).toMatchObject({ harness: 'hermes', nativeSessionId: 'chosen', files: [hermes, hermes + '-wal', hermes + '-shm'] })
  expect((await readerFor('hermes').read(picked!)).messages.map(m => m.parts)).toEqual([[{ type: 'text', text: 'Hermes response' }]])
  expect(await nativeStoreSessions(hermes, { nativeSessionId: 'missing' })).toEqual([])

  const openclaw = join(dir, 'archive')
  const schema = `
    CREATE TABLE session_windows(session_id TEXT PRIMARY KEY);
    CREATE TABLE transcript_events(session_id, seq INTEGER, event_json TEXT, event_zstd BLOB);
    INSERT INTO session_windows VALUES('chosen'),('other');
  `
  const claw = liveDatabase(openclaw, schema)
  claw.prepare('INSERT INTO transcript_events VALUES(?,1,?,NULL)').run('chosen', JSON.stringify({ type: 'message', message: { role: 'user', content: 'OpenClaw prompt' } }))
  const [ref] = await nativeStoreSessions(openclaw, { nativeSessionId: 'chosen' })
  expect(ref?.harness).toBe('openclaw')
  expect((await readerFor('openclaw').read(ref!)).messages[0]?.parts).toEqual([{ type: 'text', text: 'OpenClaw prompt' }])
  expect(await nativeStoreSessions(openclaw, { harness: 'claude-code' })).toEqual([])

  db.exec(schema)
  await expect(nativeStoreSessions(hermes)).rejects.toThrow('Multiple harness schemas')
  expect((await nativeStoreSessions(hermes, { harness: 'hermes', nativeSessionId: 'chosen' }))[0]?.harness).toBe('hermes')
})

it('reads NanoClaw from either half of a live session and leaves adjacent unrelated databases unclaimed', async () => {
  const dir = join(directory(), 'native-session')
  mkdirSync(dir)
  const inbound = join(dir, 'inbound.db')
  const outbound = join(dir, 'outbound.db')
  const columns = '(seq INTEGER PRIMARY KEY, id, timestamp, content, kind)'
  liveDatabase(outbound, 'CREATE TABLE messages_out' + columns).prepare('INSERT INTO messages_out VALUES(1,?,?,?,?)').run('out', null, 'reply', 'message')
  const [solo] = await nativeStoreSessions(outbound)
  expect(solo?.files).toEqual([outbound, outbound + '-wal', outbound + '-shm'])
  liveDatabase(inbound, 'CREATE TABLE messages_in' + columns).prepare('INSERT INTO messages_in VALUES(1,?,?,?,?)').run('in', null, 'request', 'message')
  for (const path of [inbound, outbound]) {
    const [ref] = await nativeStoreSessions(path, { nativeSessionId: 'native-session' })
    expect(ref).toMatchObject({ path: outbound, harness: 'nanoclaw', files: [outbound, outbound + '-wal', outbound + '-shm', inbound, inbound + '-wal', inbound + '-shm'] })
    expect((await readerFor('nanoclaw').read(ref!)).messages.map(m => m.parts)).toEqual([[{ type: 'text', text: 'request' }], [{ type: 'text', text: 'reply' }]])
    expect(await nativeStoreSessions(path, { nativeSessionId: 'another-session' })).toEqual([])
  }
  const foreign = join(dir, 'other.db')
  liveDatabase(foreign, 'CREATE TABLE messages_out' + columns)
  expect(await nativeStoreSessions(foreign)).toEqual([])
})

it('binds a directly opened Claude child to the recorded parent directory through the reader registry', async () => {
  const dir = join(directory(), '.claude', 'projects', 'project', 'actual-parent', 'subagents', 'nested')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'agent-child.jsonl')
  copyFileSync(join(import.meta.dirname, 'fixtures/claude-code/completed.jsonl'), path)
  const reader = readerFor('claude')
  const ref = reader.refForFile!(path)
  expect(ref).toMatchObject({ nativeSessionId: 'child', parentNativeSessionId: 'actual-parent' })
  expect((await reader.read(ref)).messages.length).toBeGreaterThan(0)
})
