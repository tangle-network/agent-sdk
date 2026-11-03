/**
 * #534: a retention manifest can run past V8's string limit while the fields a
 * listing needs stay small. The scanner streams the wanted paths out of any
 * size of manifest, and one session's unreadable manifest no longer sinks the
 * capture's whole listing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { JsonValueTooLarge, readJsonValues } from '../src/manifest-scan.js'
import { listCapture } from '../src/index.js'

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-manifest-'))
  made.push(dir)
  return dir
}

const write = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const WANTED = (path: string): boolean =>
  path === '/nativeSessions' || path === '/source/backendType' || path === '/source/nativeSessionId'
  || /^\/source\/attempts\/\d+\/(?:nativeSessionIds|executionId|ordinal)$/u.test(path)

describe('readJsonValues', () => {
  const document = {
    source: {
      backendType: 'codex',
      nativeSessionId: 'a1',
      attempts: [{ executionId: 'e1', ordinal: 1, nativeSessionIds: ['a1', 'a2'], events: { skipped: true } }],
      processStream: 'unwanted',
    },
    nativeSessions: [{ nativeSessionId: 'a1', files: [] }],
    padding: 'x'.repeat(3_000_000),
  }

  it('streams the same values the fast path returns', async () => {
    const path = write(join(scratch(), 'manifest.json'), JSON.stringify(document))
    const fast = await readJsonValues(path, WANTED, { fastPathBytes: 8 * 1024 * 1024 })
    const streamed = await readJsonValues(path, WANTED, { fastPathBytes: 16 })
    expect([...streamed.entries()].sort()).toEqual([...fast.entries()].sort())
    expect(streamed.get('/source/backendType')).toBe('codex')
    expect(streamed.get('/source/nativeSessionId')).toBe('a1')
    expect(streamed.get('/source/attempts/0/nativeSessionIds')).toEqual(['a1', 'a2'])
    expect(streamed.get('/nativeSessions')).toEqual([{ nativeSessionId: 'a1', files: [] }])
    expect(streamed.has('/source/processStream')).toBe(false)
    expect(streamed.has('/padding')).toBe(false)
  })

  it('captures a wanted value that spans read buffers, with multibyte text intact', async () => {
    const big = `αβγ ${'y'.repeat(1_050_000)} δθω`
    const path = write(join(scratch(), 'manifest.json'), JSON.stringify({ source: { backendType: big } }))
    const streamed = await readJsonValues(path, (p) => p === '/source/backendType', { fastPathBytes: 16 })
    expect(streamed.get('/source/backendType')).toBe(big)
  })

  it('refuses a wanted value over the capture ceiling, not the file', async () => {
    const path = write(join(scratch(), 'manifest.json'), JSON.stringify({ source: { backendType: 'z'.repeat(64) } }))
    await expect(readJsonValues(path, (p) => p === '/source/backendType', { fastPathBytes: 16, maxCaptureBytes: 32 })).rejects.toThrow(JsonValueTooLarge)
  })

  it('refuses trailing content', async () => {
    const path = write(join(scratch(), 'manifest.json'), '{"a":1} trailing')
    await expect(readJsonValues(path, () => false, { fastPathBytes: 16 })).rejects.toThrow(SyntaxError)
  })

  it('reads strings with escapes and quotes without confusing the scanner', async () => {
    const tricky = 'quote " brace } bracket ] comma , colon : backslash \\ end'
    const path = write(join(scratch(), 'manifest.json'), JSON.stringify({ a: tricky, b: { c: [1, 2, { d: null }] } }))
    const values = await readJsonValues(path, (p) => p === '/a' || p === '/b/c/2/d', { fastPathBytes: 16 })
    expect(values.get('/a')).toBe(tricky)
    expect(values.get('/b/c/2/d')).toBeNull()
  })
})

describe('listCapture over retention manifests (#534)', () => {
  const CODEX = readFileSync(join(import.meta.dirname, 'fixtures', 'codex', 'rollout-2026-10-04T21-50-21-01a108e5-81d9-71b0-9cec-e5d33586604f.jsonl'), 'utf8')
  const CODEX_ID = '01a108e5-81d9-71b0-9cec-e5d33586604f'

  const retention = (capture: string, sandboxSessionId: string): string => join(capture, '__retention__', 'sessions', sandboxSessionId)

  it('lists sessions from a manifest whose unrelated fields run past the string limit', async () => {
    const capture = scratch()
    const session = retention(capture, 'sbx-giant')
    const manifest = {
      source: {
        backendType: 'codex',
        attempts: [{ executionId: 'exec-1', ordinal: 1, nativeSessionIds: [CODEX_ID], eventStream: { blob: 'x'.repeat(3_000_000) } }],
      },
      processStream: { blob: 'y'.repeat(3_000_000) },
    }
    write(join(session, 'raw-manifest.json'), JSON.stringify(manifest))
    write(join(session, 'native', 'src-1', 'box', '.codex', 'sessions', '2026', '10', '04', `rollout-2026-10-04T21-50-21-${CODEX_ID}.jsonl`), CODEX)
    const listing = await listCapture(capture)
    expect(listing.missing).toEqual([])
    expect(listing.sessions.map((entry) => entry.ref.nativeSessionId)).toEqual([CODEX_ID])
    expect(listing.sessions[0]!.executionId).toBe('exec-1')
  })

  it('isolates one session\'s unreadable manifest instead of failing the capture', async () => {
    const capture = scratch()
    const good = retention(capture, 'sbx-good')
    write(join(good, 'raw-manifest.json'), JSON.stringify({ source: { backendType: 'codex', attempts: [{ executionId: 'exec-2', ordinal: 1, nativeSessionIds: [CODEX_ID] }] } }))
    write(join(good, 'native', 'src-1', 'box', '.codex', 'sessions', '2026', '10', '04', `rollout-2026-10-04T21-50-21-${CODEX_ID}.jsonl`), CODEX)
    write(join(retention(capture, 'sbx-broken'), 'raw-manifest.json'), '{"source": broken')
    const listing = await listCapture(capture)
    expect(listing.sessions.map((entry) => entry.ref.nativeSessionId)).toEqual([CODEX_ID])
    expect(listing.missing).toEqual([{ sandboxSessionId: 'sbx-broken', harness: null, reason: 'manifest_unreadable', detail: expect.any(String) }])
  })
})
