/**
 * OpenCode keeps every session in one SQLite store that it holds open while it runs. These tests
 * read copies of the trace-proof OpenCode store through the public readers and check what a read
 * leaves behind. A writer process stands in for a running OpenCode: it holds the store open with a
 * child session committed only to the write-ahead log.
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listCapture, opencodeReader, opencodeSessionsInStore, type HarnessSession, type NativeSessionCopy } from '../src/index.js'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'opencode', 'opencode.db')
const ROOT = 'ses_ef7195eb2ffeZVueR3r0KnCUON'
const TAIL = 'ses_wal_tail_child'
const made: string[] = []

afterAll(() => {
  for (const dir of made) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** A HOME whose OpenCode store is a copy of the fixture; returns the HOME and the store directory. */
function home(): { home: string; dir: string } {
  const home = scratch('hs-home-')
  const dir = join(home, '.local', 'share', 'opencode')
  mkdirSync(dir, { recursive: true })
  copyFileSync(FIXTURE, join(dir, 'opencode.db'))
  return { home, dir }
}

async function runningOpencode(store: string): Promise<{ stop(): Promise<void> }> {
  const child = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, 'running-opencode.mjs'), store, TAIL, ROOT], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve())
    child.once('exit', (code) => reject(new Error(`the writer exited with ${code} before it was ready`)))
  })
  return {
    async stop() {
      if (child.exitCode !== null) return
      child.stdin.end()
      await once(child, 'exit')
    },
  }
}

/** Each file in `dir`: a digest of its bytes and its mtime. */
function files(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => {
    const path = join(dir, name)
    return [name, `${createHash('sha256').update(readFileSync(path)).digest('hex')} ${statSync(path).mtimeMs}`]
  }))
}

/** Runs `read` with TMPDIR pointed at a new empty directory; returns what was written there. */
async function withFreshTmpdir<T>(read: () => Promise<T>): Promise<{ result: T; written: string[] }> {
  const dir = scratch('hs-tmpdir-')
  const previous = process.env.TMPDIR
  process.env.TMPDIR = dir
  try {
    return { result: await read(), written: readdirSync(dir) }
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}

/** Locate, read and summarize the fixture's session through the public reader. */
async function readHome(home: string): Promise<{ located: Array<[string, string | null]>; session: HarnessSession; summarizedCalls: number }> {
  const refs = await opencodeReader.locate(home)
  const ref = refs.find((r) => r.nativeSessionId === ROOT)!
  const session = await opencodeReader.read(ref)
  const summary = await opencodeReader.summarize(ref)
  return { located: refs.map((r) => [r.nativeSessionId, r.parentNativeSessionId]), session, summarizedCalls: summary.modelCalls }
}

describe('OpenCode store read in place', () => {
  it('reads a running store: sees its write-ahead log and leaves the store, the log and TMPDIR untouched', async () => {
    const { home: h, dir } = home()
    const writer = await runningOpencode(join(dir, 'opencode.db'))
    try {
      const before = files(dir)
      expect(Object.keys(before)).toEqual(['opencode.db', 'opencode.db-shm', 'opencode.db-wal'])
      const { result, written } = await withFreshTmpdir(() => readHome(h))
      const after = files(dir)
      expect(after['opencode.db']).toBe(before['opencode.db'])
      expect(after['opencode.db-wal']).toBe(before['opencode.db-wal'])
      expect(Object.keys(after)).toEqual(Object.keys(before))
      expect(written).toEqual([])
      // The child session exists only in the log: locate and read both see it.
      expect(result.located).toEqual([[TAIL, ROOT], [ROOT, null]])
      expect(result.session.children.map((c) => c.nativeSessionId)).toEqual([TAIL])
      expect(result.session.modelCalls).toHaveLength(3)
      expect(result.summarizedCalls).toBe(3)
      expect(result.session.integrity.sourceFiles).toEqual([
        { path: `${join(dir, 'opencode.db')}#session=${ROOT}`, sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), bytes: expect.any(Number) },
      ])
      // A symlink to the store reads the log beside its target.
      const link = join(scratch('hs-link-'), 'opencode.db')
      symlinkSync(join(dir, 'opencode.db'), link)
      expect((await opencodeSessionsInStore(link, null)).map((r) => r.nativeSessionId)).toEqual([TAIL, ROOT])
    } finally {
      await writer.stop()
    }
  })

  it('opens a store with no write-ahead log immutable: nothing is created beside it or in TMPDIR', async () => {
    const { home: h, dir } = home()
    const before = files(dir)
    const { result, written } = await withFreshTmpdir(() => readHome(h))
    expect(files(dir)).toEqual(before)
    expect(written).toEqual([])
    expect(result.located).toEqual([[ROOT, null]])
    expect(result.session.modelCalls).toHaveLength(3)
    expect(result.summarizedCalls).toBe(3)
  })

  // Root ignores directory permissions, so SQLite could create the -shm there.
  it.skipIf(process.getuid?.() === 0)('reads a store SQLite cannot open in place, a log with no -shm on read-only storage, from a private copy', async () => {
    const { home: h, dir } = home()
    const capture = scratch('hs-capture-')
    const writer = await runningOpencode(join(dir, 'opencode.db'))
    // The capture takes the store and its log while OpenCode still holds them, and no -shm.
    const { session: live } = await readHome(h).finally(async () => {
      for (const name of ['opencode.db', 'opencode.db-wal']) copyFileSync(join(dir, name), join(capture, name))
      await writer.stop()
    })
    chmodSync(capture, 0o555)
    const before = files(capture)
    const { result, written } = await withFreshTmpdir(async () => {
      const refs = await opencodeSessionsInStore(join(capture, 'opencode.db'), null)
      return { located: refs.map((r) => r.nativeSessionId), session: await opencodeReader.read(refs.find((r) => r.nativeSessionId === ROOT)!) }
    })
    expect(files(capture)).toEqual(before)
    expect(written).toEqual([expect.stringMatching(/^harness-sessions-sqlite-/)])
    expect(result.located).toEqual([TAIL, ROOT])
    // The copy and the live store hold the same rows for the session.
    expect(result.session.children).toEqual(live.children)
    expect(result.session.messages).toEqual(live.messages)
    expect(result.session.integrity.sourceFiles[0]!.sha256).toBe(live.integrity.sourceFiles[0]!.sha256)
  })
})


it('capture ownership includes deep SQLite descendants in newest-first order and excludes independent roots', async () => {
  const { home: h, dir } = home(), db = new DatabaseSync(join(dir, 'opencode.db'))
  try {
    db.prepare('UPDATE session SET time_updated=1 WHERE id=?').run(ROOT)
    const add = db.prepare('INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,parent_id) SELECT ?,project_id,slug,directory,title,version,time_created,?,? FROM session WHERE id=?')
    add.run('child', 2, ROOT, ROOT); add.run('grandchild', 3, 'child', ROOT); add.run('independent', 4, null, ROOT)
  } finally { db.close() }
  const copy = { harness: 'opencode', format: 'opencode.sqlite', executionId: 'exec-family', attempt: 1, nativeSessionId: ROOT, files: [{ path: '.local/share/opencode/opencode.db' }] } as NativeSessionCopy
  const listing = await listCapture(h, { schema: 'tangle.raw-evidence-archive.v2', nativeSessions: [copy] })
  expect(listing.missing).toEqual([])
  expect(new Set(listing.sessions.map(s => s.ref.nativeSessionId))).toEqual(new Set([ROOT, 'child', 'grandchild']))
  expect(listing.sessions.filter(s => s.recordedId).map(s => s.ref.nativeSessionId)).toEqual([ROOT])
  const absent = await listCapture(h, { schema: 'tangle.raw-evidence-archive.v2', nativeSessions: [{ ...copy, nativeSessionId: 'absent' }] })
  expect(absent.sessions).toEqual([])
  expect(absent.missing[0]?.reason).toBe('native_session_not_in_store')
})
