/**
 * Locating sessions in a HOME through the public readers. Each fixture HOME is a temp directory
 * outside the process's HOME, laid out the way Codex, acct and Claude Code write on a fleet host;
 * the session files are the trace-proof fixtures with their id and recorded cwd rewritten.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { claudeCodeReader, codexHomes, codexReader, isCodexHome, withinPath, type SessionRef } from '../src/index.js'

const fixture = (...parts: string[]): string => join(import.meta.dirname, 'fixtures', ...parts)
const CODEX = readFileSync(fixture('codex', 'rollout-2026-10-04T21-50-21-01a108e5-81d9-71b0-9cec-e5d33586604f.jsonl'), 'utf8')
const CODEX_ID = '01a108e5-81d9-71b0-9cec-e5d33586604f'
const CLAUDE = readFileSync(fixture('claude-code', 'completed.jsonl'), 'utf8')
const RECORDED_CWD = '"cwd":"/home/agent"'
const made: string[] = []

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hs-locate-'))
  made.push(dir)
  return dir
}

/** A Codex thread id (UUIDv7) made at `iso`. */
function threadId(iso: string, n: number): string {
  const ms = Date.parse(iso).toString(16).padStart(12, '0')
  return `${ms.slice(0, 8)}-${ms.slice(8)}-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function write(path: string, text: string, modified: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  utimesSync(path, new Date(modified), new Date(modified))
  return path
}

/** The trace-proof Codex rollout as thread `id` recorded in `cwd`; `extra` records make a larger copy. */
function rollout(path: string, id: string, cwd: string, modified: string, extra = 0): string {
  const text = CODEX.replaceAll(CODEX_ID, id).replaceAll(RECORDED_CWD, `"cwd":${JSON.stringify(cwd)}`)
  return write(path, text + `{"timestamp":"${modified}","type":"event_msg","payload":{"type":"task_started"}}\n`.repeat(extra), modified)
}

const day = (home: string, codexHome: string, id: string, iso: string): string =>
  join(home, codexHome, 'sessions', iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10), `rollout-${iso.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`)

const ids = (refs: readonly SessionRef[]): string[] => refs.map((r) => r.nativeSessionId).sort()

describe('Codex homes', () => {
  const home = scratch()
  const at = '2026-10-15T09:00:00.000Z'
  const live = threadId(at, 1)
  const archived = threadId(at, 2)
  const lane = threadId(at, 3)
  const account = threadId(at, 4)
  const unnamed = threadId('2026-10-15T10:00:00.000Z', 5)
  rollout(day(home, '.codex', live, at), live, `${home}/x/agent`, '2026-10-15T09:30:00.000Z')
  rollout(join(home, '.codex', 'archived_sessions', `rollout-2026-10-14T09-00-00-${archived}.jsonl`), archived, `${home}/x/agent-dev-container`, '2026-10-14T09:30:00.000Z')
  rollout(day(home, '.codex-lane', lane, at), lane, `${home}/x/agent/sub`, '2026-10-15T09:40:00.000Z')
  rollout(day(home, '.config/agent-accounts/codex/a@example.com', account, at), account, `${home}/x/other`, '2026-10-15T09:50:00.000Z')
  // acct move copied the live thread into the account's home, where it ran longer.
  const moved = rollout(day(home, '.config/agent-accounts/codex/a@example.com', live, at), live, `${home}/x/agent`, '2026-10-15T09:55:00.000Z', 3)
  // An account home that is a link to ~/.codex holds no sessions of its own.
  symlinkSync(join(home, '.codex'), join(home, '.config/agent-accounts/codex/linked'))
  // A rollout whose file name does not carry its thread id.
  const nameless = rollout(join(home, '.codex', 'sessions', '2026', '10', '15', 'rollout-2026-10-15T10-00-00.jsonl'), unnamed, `${home}/x/agent`, '2026-10-15T10:30:00.000Z')

  it('lists every Codex home once: siblings, account homes, and not a link to one already listed', async () => {
    expect(await codexHomes(home)).toEqual([
      join(home, '.codex'),
      join(home, '.codex-lane'),
      join(home, '.config/agent-accounts/codex/a@example.com'),
    ])
  })

  it('locates live, archived, sibling-home and account-home rollouts, one ref per thread from its largest copy', async () => {
    const refs = await codexReader.locate(home)
    expect(ids(refs)).toEqual([live, archived, lane, account, unnamed].sort())
    expect(refs.find((r) => r.nativeSessionId === live)?.path).toBe(moved)
    expect(refs.every((r) => r.home === home)).toBe(true)
  })

  it('finds a thread by id when its file name lacks the id', async () => {
    const refs = await codexReader.locate(home, { nativeSessionId: unnamed })
    expect(refs.map((r) => [r.nativeSessionId, r.path])).toEqual([[unnamed, nameless]])
    expect(ids(await codexReader.locate(home, { nativeSessionId: archived }))).toEqual([archived])
    expect(await codexReader.locate(home, { nativeSessionId: threadId(at, 99) })).toEqual([])
  })

  it('matches the recorded cwd on a path boundary', async () => {
    expect(ids(await codexReader.locate(home, { cwd: `${home}/x/agent` }))).toEqual([live, lane, unnamed].sort())
    expect(ids(await codexReader.locate(home, { cwd: `${home}/x/agent/` }))).toEqual([live, lane, unnamed].sort())
    expect(ids(await codexReader.locate(home, { cwd: `${home}/x/agent-dev-container` }))).toEqual([archived])
  })

  it('reads only rollouts written since the id was made when the name lacks the id', async () => {
    const root = scratch()
    const id = threadId('2026-10-15T10:00:00.000Z', 7)
    const real = rollout(join(root, '.codex', 'sessions', '2026', '10', '15', 'rollout-2026-10-15T10-00-00.jsonl'), id, '/w', '2026-10-15T10:30:00.000Z')
    // A larger file claiming the same id, last written before the id existed: it cannot be that thread.
    rollout(join(root, '.codex', 'archived_sessions', 'rollout-2026-10-01T00-00-00.jsonl'), id, '/w', '2026-10-01T00:00:00.000Z', 5)
    expect((await codexReader.locate(root, { nativeSessionId: id })).map((r) => r.path)).toEqual([real])
  })

  it('reads a fleet seat\'s codex directory passed as the store root', async () => {
    const seat = join(scratch(), 'seats', 's1', 'codex')
    const id = threadId(at, 8)
    rollout(join(seat, 'sessions', '2026', '10', '15', `rollout-2026-10-15T09-00-00-${id}.jsonl`), id, '/w', '2026-10-15T09:10:00.000Z')
    expect(isCodexHome(seat)).toBe(true)
    expect(ids(await codexReader.locate(seat))).toEqual([id])
  })

  it('applies $CODEX_HOME and $ACCT_CONFIG to this process\'s own HOME only', async () => {
    const elsewhere = scratch()
    const fromEnv = threadId(at, 9)
    const fromAcct = threadId(at, 10)
    rollout(day(elsewhere, 'codex-home', fromEnv, at), fromEnv, '/w', '2026-10-15T09:10:00.000Z')
    rollout(day(elsewhere, 'acct/codex/b@example.com', fromAcct, at), fromAcct, '/w', '2026-10-15T09:10:00.000Z')
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, ACCT_CONFIG: process.env.ACCT_CONFIG }
    try {
      process.env.CODEX_HOME = join(elsewhere, 'codex-home')
      process.env.ACCT_CONFIG = join(elsewhere, 'acct')
      process.env.HOME = home
      // $ACCT_CONFIG replaces the default accounts directory.
      expect(ids(await codexReader.locate(home))).toEqual([live, archived, lane, unnamed, fromEnv, fromAcct].sort())
      process.env.HOME = elsewhere
      expect(ids(await codexReader.locate(home))).toEqual([live, archived, lane, account, unnamed].sort())
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('Claude Code', () => {
  it('matches the recorded cwd on a path boundary', async () => {
    const home = scratch()
    const session = (dir: string, id: string, cwd: string): void => {
      write(join(home, '.claude', 'projects', dir, `${id}.jsonl`), CLAUDE.replaceAll(RECORDED_CWD, `"cwd":${JSON.stringify(cwd)}`), '2026-10-15T09:00:00.000Z')
    }
    session('-h-x-agent', 'c1', `${home}/x/agent`)
    session('-h-x-agent-dev-container', 'c2', `${home}/x/agent-dev-container`)
    session('-h-x-agent-sub', 'c3', `${home}/x/agent/sub`)
    expect(ids(await claudeCodeReader.locate(home, { cwd: `${home}/x/agent` }))).toEqual(['c1', 'c3'])
    expect(ids(await claudeCodeReader.locate(home, { cwd: `${home}/x/agent-dev-container` }))).toEqual(['c2'])
  })
})

describe('path rules', () => {
  it('withinPath is equality or a path-boundary prefix', () => {
    expect([
      withinPath('/w/agent', '/w/agent'),
      withinPath('/w/agent/sub', '/w/agent'),
      withinPath('/w/agent/', '/w/agent'),
      withinPath('/w/agent-dev-container', '/w/agent'),
      withinPath('/w/agentx/sub', '/w/agent'),
      withinPath('/w', '/'),
    ]).toEqual([true, true, true, false, false, true])
  })

  it('isCodexHome follows the trace-archive rule', () => {
    expect([
      '/h/.codex', '/h/.codex-lane', '/h/.config/agent-accounts/codex/a@example.com', '/fleet/seats/s1/codex',
      '/h/.config/agent-accounts/codex', '/h/.claude', '/h/codexes', '/h/.codexy',
    ].map(isCodexHome)).toEqual([true, true, true, true, false, false, false, false])
  })
})
