/** Actual official Kimi flat records, minimized through agent-eval's share pipeline. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { validateTraceSpans } from '@tangle-network/agent-trace-contract'
import { describe, expect, it } from 'vitest'
import {
  kimiReader, kimiRefForFile, listCapture, readCapture, readSessionInput,
  summarizeSessionInput, toChatMessages, toOtlpSpans, toTurns,
  type NativeSessionCopy, type RawEvidenceArchiveManifestV2,
} from '../src/index.js'

const fixtures = join(import.meta.dirname, 'fixtures')
const provenance = JSON.parse(readFileSync(join(fixtures, 'kimi2', 'provenance.json'), 'utf8'))
const fixture = join(fixtures, 'kimi2', provenance.fixture)
const id: string = provenance.expectedNativeSessionId
const text = readFileSync(fixture, 'utf8')
const records = text.trimEnd().split('\n').map((line) => JSON.parse(line))
const meteredZero = { input: 0, output: 0, reasoning: null, cacheRead: 0, cacheWrite: 0 }
const run = promisify(execFile)
const cli = join(import.meta.dirname, '..', 'dist', 'cli.js')

describe('retained Kimi flat session files', () => {
  it('recovers a helper and its measured work from the home and from renamed archive members', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-retained-family-'))
    const family: { parent: unknown[]; helper: unknown[] } = JSON.parse(await readFile(join(fixtures, 'kimi2', 'family.json'), 'utf8'))
    const copies: NativeSessionCopy[] = []
    const helperIds = new Set<string>()
    try {
      for (const root of ['session_one', 'session_two']) {
        const files: NativeSessionCopy['files'] = []
        for (const [agent, events] of [['main', family.parent], ['agent-0', family.helper]] as const) {
          const store = '.kimi-code/sessions'
          const storePath = `${store}/wd_fixture/${root}/agents/${agent}/wire.jsonl`
          const path = join(home, storePath)
          const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, bytes)
          const member = `payload-${copies.length}-${files.length}`
          await link(path, join(home, member))
          files.push({ path: member, store, storePath, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), method: 'byte-prefix', truncated: false })
        }
        copies.push({ harness: 'kimi-code', format: 'kimi.session-dir', executionId: root, attempt: 1, nativeSessionId: root,
          copy: 'settled', capturedAt: '2026-11-19T12:00:00Z', process: { pid: null, exitedAt: null, exitCode: null, signal: null },
          complete: true, missingReasons: [], files })
        const refs = await kimiReader.locate(home, { nativeSessionId: root })
        expect(refs).toHaveLength(2)
        const child = refs.find(ref => ref.parentNativeSessionId === root)!
        const parent = await kimiReader.read(refs.find(ref => ref.nativeSessionId === root)!)
        expect(parent.children).toEqual([{ nativeSessionId: child.nativeSessionId, toolCallId: 'call-1' }])
        const direct = await kimiReader.read(kimiRefForFile(child.path))
        expect(direct.nativeSessionId).toBe(child.nativeSessionId)
        expect(direct.parentNativeSessionId).toBe(root)
        helperIds.add(child.nativeSessionId)
      }
      expect(helperIds.size).toBe(2)
      const archive = { schema: 'tangle.raw-evidence-archive.v2', nativeSessions: copies } as const
      const recovered = []
      for await (const session of readCapture(home, archive)) recovered.push(session)
      expect(recovered).toHaveLength(4)
      for (const { nativeSessionId } of copies) {
        const root = recovered.find(s => s.nativeSessionId === nativeSessionId)!
        const child = recovered.find(s => s.parentNativeSessionId === nativeSessionId)!
        expect(helperIds.has(child.nativeSessionId)).toBe(true)
        expect(root.children).toEqual([{ nativeSessionId: child.nativeSessionId, toolCallId: 'call-1' }])
        expect(root.usage).toMatchObject({ input: 2571, output: 275 })
        expect(child.usage).toMatchObject({ input: 590, output: 368 })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('discovers both layouts and reads each native step once through file, summary, input and projections', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi2-home-'))
    try {
      const file = join(home, '.kimi-code', provenance.fixture)
      await mkdir(dirname(file), { recursive: true })
      await cp(fixture, file)
      await cp(join(fixtures, 'kimi', 'parent'), join(home, '.kimi', 'sessions', 'legacy', 'parent'), { recursive: true })
      const all = await kimiReader.locate(home)
      expect(all.map((ref) => ref.nativeSessionId).sort()).toEqual([
        id, 'parent', 'id-011afd997439', 'id-4fb3cf18797e',
      ].sort())
      for (const legacy of all.filter((ref) => ref.nativeSessionId !== id)) {
        expect((await kimiReader.read(legacy)).ending.status).toBe('completed')
      }
      const [ref] = await kimiReader.locate(home, { nativeSessionId: id })
      expect(ref?.nativeSessionId).toBe(id)
      expect(ref?.parentNativeSessionId).toBeNull()
      expect(kimiRefForFile(file).nativeSessionId).toBe(id)
      const session = await kimiReader.read(ref!)
      const summary = await kimiReader.summarize(ref!)
      expect(createHash('sha256').update(text).digest('hex')).toBe(provenance.fixtureSha256)
      expect(records).toHaveLength(33)
      expect(session.nativeSessionId).toBe(id)
      expect(session.messages.map((message) => [message.role, message.actor])).toEqual([
        ['user', 'human'], ['user', 'injected'], ['assistant', 'agent'], ['tool', 'tool-result'], ['assistant', 'agent'],
      ])
      expect(session.modelCalls.map((call) => [call.requestedModel, call.servedModel, call.stopReason, call.usage])).toEqual([
        ['fixture-model', null, 'tool_use', meteredZero], ['fixture-model', null, 'end_turn', meteredZero],
      ])
      expect(session.toolCalls.map((call) => [call.id, call.status, call.input, call.result?.output])).toEqual([
        ['id-321ac8f9179d', 'completed', { command: '[REDACTED:fixture-content]' }, '[REDACTED:fixture-content]'],
      ])
      expect(session.servedModels).toEqual({})
      expect(session.modelSource).toBe('none')
      expect(session.usage).toEqual(meteredZero)
      expect(session.ending).toEqual({ status: 'completed', error: null, at: '2026-10-26T18:52:00.441Z' })
      expect(summary).toMatchObject({ nativeSessionId: id, modelCalls: 2, replies: 2, toolCalls: 1, usage: session.usage, ending: session.ending })
      for (const input of [{ text }, { records }]) {
        const fromInput = readSessionInput('kimi-code', input, { nativeSessionId: id })
        expect(fromInput.messages).toEqual(session.messages)
        expect(fromInput.toolCalls).toEqual(session.toolCalls)
        expect(fromInput.modelCalls).toEqual(session.modelCalls)
        expect(fromInput.ending).toEqual(session.ending)
        expect(summarizeSessionInput('kimi-code', input, { nativeSessionId: id }).usage).toEqual(session.usage)
      }
      expect(toChatMessages(session, { injected: false }).map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
      expect(toTurns(session).filter((turn) => turn.role === 'assistant').map((turn) => turn.usage)).toEqual([meteredZero, meteredZero])
      const spans = toOtlpSpans(session)
      expect(validateTraceSpans(spans).findings.filter((finding) => finding.severity === 'error')).toEqual([])
      expect(new Set(spans.map((span) => span.span_id)).size).toBe(spans.length)
      expect((await kimiReader.locate(home, { cwd: session.cwd! })).map((value) => value.nativeSessionId)).toEqual([id])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps real prefixes open and unmetered prefixes unknown despite completed-looking assistant content', () => {
    const firstUsage = records.findIndex((record) => record.type === 'usage.record')
    const unmetered = readSessionInput('kimi-code', { records: records.slice(0, firstUsage) }, { nativeSessionId: id })
    expect(unmetered.modelCalls).toHaveLength(1)
    expect(unmetered.usage).toBeNull()
    expect(unmetered.ending.status).toBe('open')
    const firstEnd = records.findIndex((record) => record.type === 'agent.turn.ended')
    const partial = readSessionInput('kimi-code', { records: records.slice(0, firstEnd) }, { nativeSessionId: id })
    expect(partial.modelCalls).toHaveLength(2)
    expect(partial.messages.at(-1)?.role).toBe('assistant')
    expect(partial.usage).toEqual(meteredZero)
    expect(partial.ending).toEqual({ status: 'open', error: null, at: null })
  })

  it('retains the closed turn when a queued prompt opens and never reports usage', async () => {
    // Numerical fields from one retained Kimi 1.5 native wire. Original SHA-256
    // c2056fbc8a7a3656510bc4ec5ba18c9c675de19fab5055a71e131fd39d846a1f.
    const raw = await readFile(join(fixtures, 'kimi2', 'queued-turn-accounting.jsonl'), 'utf8')
    const rows = raw.trimEnd().split('\n').map(line => JSON.parse(line))
    const resume = rows.findIndex(row => row.type === 'turn.prompt' && row.turnId === 2)
    const first = { id: '0', firstModelCall: 0, endModelCall: 11, ending: expect.objectContaining({ status: 'completed' }),
      usage: { input: 66200, output: 5650, reasoning: null, cacheRead: 427008, cacheWrite: 0 } }
    const pending = summarizeSessionInput('kimi-code', { records: rows.slice(0, resume) }, { nativeSessionId: id })
    expect(pending).toMatchObject({ modelCalls: 12, ending: { status: 'open' }, turnReceipts: [first] })
    const settled = readSessionInput('kimi-code', { records: rows }, { nativeSessionId: id })
    expect(settled.turnReceipts).toEqual([first, {
      id: '2', firstModelCall: 12, endModelCall: 13, ending: expect.objectContaining({ status: 'completed' }),
      usage: { input: 53888, output: 303, reasoning: null, cacheRead: 27904, cacheWrite: 0 },
    }])
  })

  it('joins real v2 capture payloads to both layouts and infers current direct-file CLI identity', async () => {
    const archive = await mkdtemp(join(tmpdir(), 'kimi2-archive-'))
    try {
      const copies: NativeSessionCopy[] = []
      for (const [nativeSessionId, source, store, relative] of [
        [id, fixture, '.kimi-code/sessions', `wd_fixture/${id}/agents/main/wire.jsonl`],
        ['parent', join(fixtures, 'kimi', 'parent', 'wire.jsonl'), '.kimi/sessions', 'legacy/parent/wire.jsonl'],
      ]) {
        const bytes = await readFile(source!)
        const member = `wire-${copies.length}.payload`
        await writeFile(join(archive, member), bytes)
        copies.push({
          harness: 'kimi-code', format: 'kimi.session-dir', executionId: `execution-${copies.length}`, attempt: 1,
          nativeSessionId: nativeSessionId!, copy: 'settled', capturedAt: '2026-10-26T18:52:01.000Z',
          process: { pid: null, exitedAt: null, exitCode: null, signal: null }, complete: false, missingReasons: ['fixture retains only the primary wire'],
          files: [{ path: member, store: store!, storePath: `${store}/${relative}`, sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), method: 'byte-prefix', truncated: false }],
        })
      }
      const manifest: RawEvidenceArchiveManifestV2 = { schema: 'tangle.raw-evidence-archive.v2', nativeSessions: copies }
      const listing = await listCapture(archive, manifest)
      expect(listing.missing).toEqual([])
      expect(listing.sessions.map((value) => value.ref.nativeSessionId)).toEqual([id, 'parent'])
      const captured = []
      for await (const session of readCapture(archive, manifest)) captured.push(session)
      expect(captured[0]).toMatchObject({ nativeSessionId: id, usage: meteredZero, ending: { status: 'completed' } })
      expect(captured[1]?.usage).toEqual({ input: 35022, output: 3981, reasoning: null, cacheRead: 302848, cacheWrite: 0 })
      // A bounded copy can stop at a complete row; byte parsing alone cannot expose its limit.
      const end = records.findIndex((record) => record.type === 'agent.turn.ended')
      const prefix = `${text.trimEnd().split('\n').slice(0, end).join('\n')}\n`
      const copy = copies[0]!
      const member = copy.files[0]!
      await writeFile(join(archive, member.path), prefix)
      member.sizeBytes = Buffer.byteLength(prefix)
      member.sha256 = createHash('sha256').update(prefix).digest('hex')
      member.truncated = true
      copy.copy = 'snapshot'
      const partialListing = await listCapture(archive, { ...manifest, nativeSessions: [copy] })
      const partial = await kimiReader.read(partialListing.sessions[0]!.ref)
      expect(partial.integrity.truncated).toBe(true)
      expect(partial.ending.status).toBe('open')
      expect(partial.usage).toEqual(meteredZero)
      const direct = join(archive, '.kimi-code', provenance.fixture)
      await mkdir(dirname(direct), { recursive: true })
      await cp(fixture, direct)
      const { stdout } = await run(process.execPath, [cli, 'read', direct, '--session', id, '--json', '--summary'], { timeout: 10_000 })
      expect(JSON.parse(stdout)).toMatchObject({ nativeSessionId: id, modelCalls: 2, toolCalls: 1, usage: meteredZero })
    } finally {
      await rm(archive, { recursive: true, force: true })
    }
  })
})
