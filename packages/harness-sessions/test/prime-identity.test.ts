import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { isPrimeSessionHeader, piReader, piRefForFile, primeParentNativeSessionId, primeReader, primeRefForFile, readSessionInput, summarizeSessionInput } from '../src/index.js'

const scratch: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'prime-identity-'))
  scratch.push(path)
  return path
}

function fixture(name: string): string {
  return join(import.meta.dirname, 'fixtures', 'prime', name)
}

function store(dir: string, name = 'sessions'): string {
  const path = join(dir, 'home', '.prime-provider', 'prime-agent-dirs', 'writer', name)
  mkdirSync(path, { recursive: true })
  return path
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ROOT_ID = '3f1c0a52-9b34-4c1d-8e2f-a1b2c3d4e5f6'
const FORK_ID = '7d2e9b63-4a55-4d8e-9f0a-b2c3d4e5f6a7'
const PARENT_SESSION = `/tmp/generic-home/.prime-provider/prime-agent-dirs/capture/sessions/${ROOT_ID}.jsonl`
const FORK = {
  parentNativeSessionId: ROOT_ID,
  parentSession: PARENT_SESSION,
  rlmDepth: 0,
  userFork: true,
  createdAt: '2026-11-20T10:00:04.500Z',
  inheritedEntries: 6,
}

it('recognizes the Prime marker exactly: a session header with a nonnegative integer rlmDepth', () => {
  expect(isPrimeSessionHeader(JSON.parse(readFileSync(fixture('root.jsonl'), 'utf8').split('\n')[0]!))).toBe(true)
  expect(isPrimeSessionHeader(JSON.parse(readFileSync(fixture('fork.jsonl'), 'utf8').split('\n')[0]!))).toBe(true)
  expect(isPrimeSessionHeader({ type: 'session', version: 3, id: 'x', timestamp: '2026-11-20T10:00:00.000Z', cwd: '/w', rlmDepth: 0 })).toBe(true)
  // The Pi family writes version without ever writing rlmDepth: an ordinary Pi header is not Prime.
  expect(isPrimeSessionHeader(JSON.parse(readFileSync(fixture('legacy-unmarked.jsonl'), 'utf8').split('\n')[0]!))).toBe(false)
  expect(isPrimeSessionHeader(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'pi', '2026-10-05T00-42-50-830Z_7b2f3c4e-1d2a-4b5c-8e9f-0a1b2c3d4e5f.jsonl'), 'utf8').split('\n')[0]!))).toBe(false)
  expect(isPrimeSessionHeader({ type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/w', rlmDepth: 1 })).toBe(true)
  expect(isPrimeSessionHeader({ type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/w', rlmDepth: -1 })).toBe(false)
  expect(isPrimeSessionHeader({ type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/w', rlmDepth: 1.5 })).toBe(false)
  expect(isPrimeSessionHeader({ type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/w', rlmDepth: '0' })).toBe(false)
  expect(isPrimeSessionHeader({ type: 'session', version: 3, id: '', timestamp: 't', cwd: '/w', rlmDepth: 0 })).toBe(false)
  expect(isPrimeSessionHeader({ type: 'message', id: 'x', rlmDepth: 0 })).toBe(false)
  expect(isPrimeSessionHeader(null)).toBe(false)
  expect(isPrimeSessionHeader('session')).toBe(false)
})

it('derives the parent native ID from a recorded parentSession reference without touching the filesystem', () => {
  expect(primeParentNativeSessionId(PARENT_SESSION)).toBe(ROOT_ID)
  expect(primeParentNativeSessionId(`C:\\home\\sessions\\${ROOT_ID}.jsonl`)).toBe(ROOT_ID)
  expect(primeParentNativeSessionId(ROOT_ID)).toBe(ROOT_ID)
})

it('keeps the recorded ID, cwd and reader identity when a marked session is copied under another filename', async () => {
  const dir = directory()
  const sessions = store(dir)
  copyFileSync(fixture('root.jsonl'), join(sessions, 'shared-recording.jsonl'))
  const home = join(dir, 'home')

  const [located] = await primeReader.locate(home, { nativeSessionId: ROOT_ID })
  expect(located).toMatchObject({ harness: 'prime', format: 'prime.session-jsonl', nativeSessionId: ROOT_ID, cwd: '/work/project', parentNativeSessionId: null })
  expect(await primeReader.locate(home, { nativeSessionId: 'shared-recording', cwd: '/work/project' })).toHaveLength(1)
  expect(await primeReader.locate(home, { nativeSessionId: ROOT_ID, cwd: '/elsewhere' })).toHaveLength(0)

  const session = await primeReader.read(primeRefForFile(join(sessions, 'shared-recording.jsonl')))
  expect(session.harness).toBe('prime')
  expect(session.nativeSessionId).toBe(ROOT_ID)
  expect(session.parentNativeSessionId).toBeNull()
  expect(session.fork).toBeUndefined()
  expect(session.cwd).toBe('/work/project')
  expect((await primeReader.summarize(located!)).nativeSessionId).toBe(ROOT_ID)
})

it('represents the recorded fork edge: parent ID, verbatim reference, user fork and inherited prehistory', async () => {
  const dir = directory()
  const sessions = store(dir)
  copyFileSync(fixture('root.jsonl'), join(sessions, `${ROOT_ID}.jsonl`))
  copyFileSync(fixture('fork.jsonl'), join(sessions, `${FORK_ID}.jsonl`))
  const home = join(dir, 'home')

  const [forkRef] = await primeReader.locate(home, { nativeSessionId: FORK_ID })
  expect(forkRef).toMatchObject({ nativeSessionId: FORK_ID, parentNativeSessionId: ROOT_ID, cwd: '/work/project' })
  const [byParentStem] = await primeReader.locate(home, { nativeSessionId: ROOT_ID })
  expect(byParentStem!.nativeSessionId).toBe(ROOT_ID)

  const fork = await primeReader.read(forkRef!)
  expect(fork.fork).toEqual(FORK)
  expect(fork.parentNativeSessionId).toBe(ROOT_ID)
  expect(fork.messages.map((message) => message.inherited === true)).toEqual([true, true, true, true, false, false])
  expect(fork.messages.filter((message) => message.actor === 'human').map((message) => message.id)).toEqual(['e1', 'e6'])
  // The replayed tool call stays a single in-session call, and its message is inherited evidence.
  expect(fork.toolCalls.map((call) => call.id)).toEqual(['call_native_1'])
  expect(fork.toolCalls[0]!.messageId).toBe('e2')
  expect(fork.messages.find((message) => message.id === 'e2')!.inherited).toBe(true)
  expect((await primeReader.summarize(forkRef!)).fork).toEqual(FORK)

  const root = await primeReader.read(byParentStem!)
  expect(root.parentNativeSessionId).toBeNull()
  expect(root.fork).toBeUndefined()
  // Exclusive ownership across the family: only the root's copy of the tool call is not inherited.
  const family = [root, fork]
  expect(family.filter((session) => session.toolCalls.some((call) => call.messageId === 'e2' && session.messages.find((m) => m.id === call.messageId)?.inherited !== true)).length).toBe(1)
})

it('keeps the established store filename identity for unmarked historical Prime recordings', async () => {
  const dir = directory()
  const sessions = store(dir)
  copyFileSync(fixture('legacy-unmarked.jsonl'), join(sessions, 'legacy-note.jsonl'))
  const home = join(dir, 'home')

  const [ref] = await primeReader.locate(home, {})
  expect(ref).toMatchObject({ harness: 'prime', nativeSessionId: 'legacy-note', cwd: null, parentNativeSessionId: null })
  const session = await primeReader.read(ref!)
  expect(session.nativeSessionId).toBe('legacy-note')
  expect(session.parentNativeSessionId).toBeNull()
  expect(session.fork).toBeUndefined()
  expect(await primeReader.locate(home, { nativeSessionId: 'header-recorded-legacy-id' })).toEqual([])
})

it('reads marked Prime sessions through the public input readers with the header ID and the caller fallback', async () => {
  const rootText = readFileSync(fixture('root.jsonl'), 'utf8')
  const session = readSessionInput('prime', { text: rootText })
  expect(session.harness).toBe('prime')
  expect(session.format).toBe('prime.session-jsonl')
  expect(session.nativeSessionId).toBe(ROOT_ID)
  expect(session.toolCalls.map((call) => call.id)).toEqual(['call_native_1'])

  const forkSummary = summarizeSessionInput('prime', { text: readFileSync(fixture('fork.jsonl'), 'utf8') })
  expect(forkSummary.nativeSessionId).toBe(FORK_ID)
  expect(forkSummary.parentNativeSessionId).toBe(ROOT_ID)
  expect(forkSummary.fork).toEqual(FORK)

  // An unmarked stream keeps the caller's session ID; the ambiguous header ID is not adopted.
  const legacy = readSessionInput('prime', { text: readFileSync(fixture('legacy-unmarked.jsonl'), 'utf8') }, { nativeSessionId: 'shared-recording' })
  expect(legacy.nativeSessionId).toBe('shared-recording')
  expect(legacy.fork).toBeUndefined()

  // A delegated fork edge (rlmDepth above the conversation level) is reported, not turned into a user fork.
  const delegated = readSessionInput('prime', { records: [
    { type: 'session', version: 3, id: 'child-1', timestamp: '2026-11-20T11:00:00.000Z', cwd: '/w', parentSession: '/tmp/h/sessions/parent-1.jsonl', rlmDepth: 1 },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Delegated task.' }], timestamp: 1770000000000 }, id: 'c1', parentId: null, timestamp: '2026-11-20T11:00:01.000Z' },
  ] })
  expect(delegated.fork).toEqual({ parentNativeSessionId: 'parent-1', parentSession: '/tmp/h/sessions/parent-1.jsonl', rlmDepth: 1, userFork: false, createdAt: '2026-11-20T11:00:00.000Z', inheritedEntries: 0 })
  expect(delegated.messages[0]!.actor).toBe('subagent-spawn')
})

it('still reads the same unmarked bytes as ordinary Pi with the Pi header identity', async () => {
  const dir = directory()
  const piStore = join(dir, 'home', '.pi', 'agent', 'sessions', 'work')
  mkdirSync(piStore, { recursive: true })
  const piPath = join(piStore, '2026-11-20T09-00-00-000Z_9d8e7f6a-5b4c-4d3e-2f1a-0b9c8d7e6f5a.jsonl')
  writeFileSync(piPath, readFileSync(fixture('legacy-unmarked.jsonl')))
  const refs = await piReader.locate(join(dir, 'home'), {})
  expect(refs.map((ref) => ref.nativeSessionId)).toEqual(['header-recorded-legacy-id'])
  const session = await piReader.read(piRefForFile(piPath))
  expect(session.harness).toBe('pi')
  expect(session.nativeSessionId).toBe('header-recorded-legacy-id')
  expect(session.fork).toBeUndefined()
  expect(readSessionInput('pi', { text: readFileSync(piPath, 'utf8') }).nativeSessionId).toBe('header-recorded-legacy-id')
})
