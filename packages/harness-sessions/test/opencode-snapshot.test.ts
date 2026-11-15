import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import {
  assertStoreRoot, captureOpenCodeSessionStore, readBoundHarnessSessions,
  readOpenCodeSessionSnapshot, type HarnessFileBinding,
} from '../src/index.js'
import { withSqliteReadSnapshot } from '../src/source.js'

const ROOT = 'ses_ef7195eb2ffeZVueR3r0KnCUON'
const CHILD = 'ses_wal_snapshot_child'
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

it('holds a consistent read transaction when a live store has no WAL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-read-lock-'))
  const path = join(dir, 'sessions.db')
  const writer = new DatabaseSync(path)
  try {
    writer.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=1; CREATE TABLE observed(value TEXT); INSERT INTO observed VALUES (\'first\')')
    await withSqliteReadSnapshot(path, db => {
      expect(db.prepare('SELECT value FROM observed').get()?.value).toBe('first')
      expect(() => writer.prepare("UPDATE observed SET value='later'").run()).toThrow('locked')
      expect(db.prepare('SELECT value FROM observed').get()?.value).toBe('first')
    })
    writer.prepare("UPDATE observed SET value='later'").run()
    expect(writer.prepare('SELECT value FROM observed').get()?.value).toBe('later')
  } finally {
    writer.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('captures a committed WAL family without credentials, unrelated sessions or a second physical read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-bound-snapshot-'))
  const source = join(dir, 'opencode.db')
  await copyFile(join(import.meta.dirname, 'fixtures/opencode/opencode.db'), source)
  const setup = new DatabaseSync(source)
  setup.exec("CREATE TABLE credential_guard_probe(value TEXT); INSERT INTO credential_guard_probe VALUES('credential-must-never-be-captured')")
  setup.prepare('INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) SELECT ?,project_id,slug,directory,title,version,time_created,time_updated FROM session WHERE id=?').run('unrelated-session', ROOT)
  setup.close()
  const writer = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, 'running-opencode.mjs'), source, CHILD, ROOT], { stdio: ['pipe', 'pipe', 'inherit'] })
  try {
    await Promise.race([
      once(writer.stdout, 'data'),
      once(writer, 'exit').then(([code]) => { throw new Error(`WAL writer exited before readiness: ${code}`) }),
    ])
    const before = [digest(await readFile(source)), digest(await readFile(`${source}-wal`))]
    const capture = await captureOpenCodeSessionStore(source, [ROOT])
    expect(capture.nativeSessionIds).toEqual([ROOT, CHILD])
    expect(Buffer.from(capture.bytes).includes(Buffer.from('credential-must-never-be-captured'))).toBe(false)
    expect(Buffer.from(capture.bytes).includes(Buffer.from('unrelated-session'))).toBe(false)
    expect([digest(await readFile(source)), digest(await readFile(`${source}-wal`))]).toEqual(before)
    const saved = join(dir, 'captured.db')
    await writeFile(saved, capture.bytes)
    const retained = new DatabaseSync(saved, { readOnly: true })
    expect(retained.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name)).toEqual(['message', 'part', 'session'])
    retained.close()
    const files = capture.nativeSessionIds.map(nativeSessionId => ({
      path: 'native/sessions.db', nativeSessionId, sha256: digest(capture.bytes), byteLength: capture.bytes.length,
    }))
    let reads = 0
    const input = {
      nativeSessionId: ROOT, files, validatePath: assertStoreRoot,
      read: async () => { reads++; return capture.bytes },
      parseBytes: (bytes: Uint8Array, file: HarnessFileBinding, signal?: AbortSignal) =>
        readOpenCodeSessionSnapshot(bytes, file.nativeSessionId, { label: file.path, signal }),
    }
    const family = await readBoundHarnessSessions(input)
    expect(reads).toBe(1)
    expect(family.sessions.map(session => session.nativeSessionId)).toEqual([ROOT, CHILD])
    expect(family.sessions[0]!.modelCalls).toHaveLength(3)
    expect(family.sessions[0]!.usage).toMatchObject({ input: 300, output: 60 })
    expect(family.sessions[1]!.parentNativeSessionId).toBe(ROOT)
    await expect(readBoundHarnessSessions({ ...input, files: [files[0]!] })).rejects.toThrow('not retained')
    await expect(readBoundHarnessSessions({ ...input, files: [files[0]!, { ...files[1]!, sha256: '0'.repeat(64) }] })).rejects.toThrow('bytes changed')
    await expect(captureOpenCodeSessionStore(source, ['missing'])).rejects.toThrow('not found')
  } finally {
    writer.stdin.end()
    if (writer.exitCode === null) await once(writer, 'exit')
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)

it('refuses whole stores, missing WAL data and cancellation after asynchronous parsing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-snapshot-refusal-'))
  const source = join(dir, 'opencode.db')
  try {
    await copyFile(join(import.meta.dirname, 'fixtures/opencode/opencode.db'), source)
    const raw = await readFile(source)
    raw[18] = 2; raw[19] = 2
    await expect(readOpenCodeSessionSnapshot(raw, ROOT)).rejects.toThrow('WAL dependency')
    const captured = await captureOpenCodeSessionStore(source, [ROOT])
    const path = join(dir, 'extra.db')
    await writeFile(path, captured.bytes)
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE account(access_token TEXT)')
    db.close()
    await expect(readOpenCodeSessionSnapshot(await readFile(path), ROOT)).rejects.toThrow('only its native session tables')
    const controller = new AbortController()
    await expect(readBoundHarnessSessions({
      nativeSessionId: ROOT, files: [{ path: 'native/session.db', nativeSessionId: ROOT }],
      validatePath: assertStoreRoot, read: async () => captured.bytes, signal: controller.signal,
      parseBytes: async bytes => {
        const session = await readOpenCodeSessionSnapshot(bytes, ROOT)
        controller.abort(new Error('capture cancelled'))
        return session
      },
    })).rejects.toThrow('capture cancelled')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
