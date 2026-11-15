import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { validateTraceSpans } from '@tangle-network/agent-trace-contract'
import { assertStoreRoot, geminiRefForFile, listCapture, readerFor, readerForFormat, readBoundHarnessSessions, readSessionInput, toChatMessages, toOtlpSpans, type RawEvidenceArchiveManifestV2 } from '../src/index.js'

const path = join(import.meta.dirname, 'fixtures/gemini/native-0.68.0.jsonl')
const nativeId = '11111111-2222-4333-8444-555555555555'
const requestedModel = 'gemini-2.5-flash'
const usage = { input: 186, output: 40, reasoning: 6, cacheRead: 14, cacheWrite: null }
const run = promisify(execFile)

describe('Gemini native session boundary', () => {
  it('reads the real CLI tool exchange once through the public reader, bounded capture and projections', async () => {
    // CLI0.68.0 wrote this file against a localhost Google API script: two responses,
    // one actual read_file and a final answer. See the adjacent provenance record.
    const reader = readerFor('gemini-cli')
    expect(readerForFormat('gemini.chat-jsonl')).toBe(reader)
    const ref = geminiRefForFile(path, nativeId)
    const session = await reader.read(ref, { corruption: 'strict' })
    const summary = await reader.summarize(ref)
    expect(session.nativeSessionId).toBe(nativeId)
    expect(session.format).toBe('gemini.chat-jsonl')
    expect(session.modelCalls).toHaveLength(2)
    expect(session.modelCalls.map(call => call.requestedModel)).toEqual([requestedModel, requestedModel])
    // The scripted response modelVersion differs, but the persisted record keeps
    // only the requested model. That record cannot certify a served identity.
    expect(session.modelCalls.every(call => call.servedModel === null && call.provider === null)).toBe(true)
    expect(session.servedModels).toEqual({})
    expect(session.modelSource).toBe('turn-context')
    expect(session.usage).toEqual(usage)
    expect(session.toolCalls).toHaveLength(1)
    expect(session.toolCalls[0]).toMatchObject({ name: 'read_file', status: 'completed', input: { file_path: 'fixture.txt' }, result: { text: 'GEMINI-SESSION-READER-PROOF\n', isError: false } })
    expect(session.messages.filter(message => message.actor === 'human')).toHaveLength(1)
    expect(session.messages.filter(message => message.actor === 'tool-result')).toHaveLength(1)
    expect(session.messages[0]?.actor).toBe('injected')
    expect(session.ending.status).toBe('open')
    expect(session.integrity).toMatchObject({ unparsedRecords: 0, truncated: false, gaps: [] })
    expect(summary).toMatchObject({ modelCalls: 2, toolCalls: 1, usage, ending: session.ending })
    expect(toChatMessages(session).map(message => message.role)).toEqual(['user', 'user', 'assistant', 'tool', 'assistant'])
    expect(validateTraceSpans(toOtlpSpans(session)).ok).toBe(true)
    const files = [{ path: 'native.jsonl', nativeSessionId: nativeId }]
    const bytes = await readFile(path)
    const captured = await readBoundHarnessSessions({ nativeSessionId: nativeId, files, validatePath: assertStoreRoot, read: async () => bytes,
      parse: (text, file) => readSessionInput('gemini', { text }, { nativeSessionId: file.nativeSessionId, label: path }, { corruption: 'strict' }) })
    expect(captured.sessions[0]).toEqual(session)
    const boundCwd = '/controlled/native/workspace'
    const rows = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    rows[0].projectHash = createHash('sha256').update(boundCwd).digest('hex')
    const boundBytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const readAt = (cwd: string) => readBoundHarnessSessions({ nativeSessionId: nativeId, files, validatePath: assertStoreRoot, read: async () => boundBytes,
      parse: (text, file) => readSessionInput('gemini', { text }, { nativeSessionId: file.nativeSessionId, cwd, label: path }, { corruption: 'strict' }) })
    expect((await readAt(boundCwd)).sessions[0]).toMatchObject({ cwd: boundCwd, nativeSessionId: nativeId, usage })
    await expect(readAt('/another/native/workspace')).rejects.toThrow('identity or integrity')
    await expect(readBoundHarnessSessions({ nativeSessionId: 'another-session', files: [{ ...files[0]!, nativeSessionId: 'another-session' }], validatePath: assertStoreRoot, read: async () => bytes,
      parse: (text, file) => readSessionInput('gemini', { text }, { nativeSessionId: file.nativeSessionId }, { corruption: 'strict' }) })).rejects.toThrow('identity or integrity')
  })

  it('locates the full header identity independently of the shortened filename and reads legacy JSON', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gemini-reader-'))
    const dir = join(home, '.gemini/tmp/project/chats')
    try {
      await mkdir(dir, { recursive: true })
      const text = await readFile(path, 'utf8')
      const records = text.trim().split('\n').map(line => JSON.parse(line))
      const messages = new Map<string, unknown>()
      let header = records[0]
      for (const record of records) {
        if (record.id) messages.set(record.id, record)
        if (record.$set) header = { ...header, ...record.$set }
      }
      await writeFile(join(dir, 'session-short-prefix.jsonl'), text)
      await writeFile(join(dir, 'session-legacy-prefix.json'), JSON.stringify({ ...header, messages: [...messages.values()] }, null, 2))
      const reader = readerFor('gemini')
      const refs = await reader.locate(home, { nativeSessionId: nativeId })
      expect(refs.map(ref => ref.format).sort()).toEqual(['gemini.chat-json', 'gemini.chat-jsonl'])
      for (const ref of refs) {
        const session = await reader.read(ref)
        expect(session.nativeSessionId).toBe(nativeId)
        expect(session.usage).toEqual(usage)
        expect(session.toolCalls).toHaveLength(1)
      }
      expect(await reader.locate(home, { nativeSessionId: '11111111' })).toEqual([])
      expect(await reader.locate(home, { cwd: '/a-different-project' })).toEqual([])
      const legacy = await readFile(join(dir, 'session-legacy-prefix.json'), 'utf8')
      expect(readSessionInput('gemini', { text: legacy }).usage).toEqual(usage)
      const cli = join(import.meta.dirname, '..', 'dist', 'cli.js')
      const direct = join(dir, 'session-short-prefix.jsonl')
      const native = await run(process.execPath, [cli, 'read', direct, '--session', nativeId, '--summary', '--json'], { timeout: 10_000 })
      expect(JSON.parse(native.stdout)).toMatchObject({ harness: 'gemini', nativeSessionId: nativeId, modelCalls: 2, usage })
      expect((await run(process.execPath, [cli, 'read', direct, '--session', '11111111', '--json'], { timeout: 10_000 })).stdout).toBe('')
      const wrong = text.replaceAll(nativeId, '11111111-2222-4333-8444-555555555556')
      await writeFile(join(dir, 'session-wrong-prefix.jsonl'), wrong)
      const manifest: RawEvidenceArchiveManifestV2 = { schema: 'tangle.raw-evidence-archive.v2', nativeSessions: [{ harness: 'gemini', format: 'gemini.chat-jsonl', executionId: 'fixture-execution', attempt: 1, nativeSessionId: nativeId, copy: 'settled', capturedAt: '2026-11-15T05:42:54Z', process: { pid: null, exitedAt: '2026-11-15T05:42:54Z', exitCode: 0, signal: null }, complete: true, missingReasons: [], files: [['wrong', wrong], ['short', text]].map(([name, value]) => ({ path: `.gemini/tmp/project/chats/session-${name}-prefix.jsonl`, store: '.gemini/tmp', sizeBytes: Buffer.byteLength(value!), sha256: createHash('sha256').update(value!).digest('hex'), method: 'atomic-file', truncated: false })) }] }
      const capture = await listCapture(home, manifest)
      expect(capture.missing).toEqual([])
      expect(capture.sessions).toHaveLength(1)
      expect(capture.sessions[0]?.ref).toMatchObject({ nativeSessionId: nativeId, path: direct, files: [direct] })
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('keeps replay patches idempotent and refuses edited, rewound or torn bound evidence', async () => {
    const text = await readFile(path, 'utf8')
    const records = text.trim().split('\n').map(line => JSON.parse(line))
    const final = records.filter(record => record.type === 'gemini').at(-1)
    const read = (suffix: unknown[]) => readSessionInput('gemini', { text: text + suffix.map(row => JSON.stringify(row)).join('\n') + '\n' }, { nativeSessionId: nativeId }, { corruption: 'strict' })
    expect(read([final]).usage).toEqual(usage)
    const patched = read([{ $patch: { updates: [{ id: final.id, content: 'Patched retained answer.' }] } }])
    expect(patched.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Patched retained answer.' }])
    expect(patched.modelCalls).toHaveLength(2)
    const rewound = read([{ $rewindTo: final.id }])
    expect(rewound.modelCalls).toHaveLength(1)
    expect(rewound.integrity.gaps).toContain('Gemini rewound or replaced history; messages and usage cover the retained conversation only')
    expect(read([{ $set: { sessionId: 'changed-id' } }]).integrity.gaps).toContain('Gemini log changes its recorded session identity')
    expect(readSessionInput('gemini', { text: text + '{"id":' }).integrity.truncated).toBe(true)
    expect(() => readSessionInput('gemini', { text: text + 'not-json\n' }, {}, { corruption: 'strict' })).toThrow('malformed JSON')
  })

  it('keeps actual pre-tool prefixes and final-looking replies open without a native terminal marker', async () => {
    const text = await readFile(path, 'utf8')
    const records = text.trim().split('\n').map(line => JSON.parse(line))
    const firstReply = records.findIndex(record => record.type === 'gemini')
    // The real0.68 recorder first appends an empty assistant with usage (line6), then
    // updates it with the completed read_file (line8). A kill between them is not completion.
    expect(firstReply).toBe(5)
    for (const length of [firstReply + 1, firstReply + 2]) {
      const prefix = readSessionInput('gemini', { records: records.slice(0, length) }, { nativeSessionId: nativeId })
      expect(prefix.modelCalls).toHaveLength(1)
      expect(prefix.toolCalls).toEqual([])
      expect(prefix.messages.at(-1)).toMatchObject({ role: 'assistant', actor: 'injected' })
      expect(prefix.messages.filter(message => message.actor === 'agent')).toEqual([])
      expect(prefix.ending).toEqual({ status: 'open', at: null, error: null })
      expect(prefix.integrity.gaps).toEqual([])
    }
    const full = readSessionInput('gemini', { records }, { nativeSessionId: nativeId })
    expect(full.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'GEMINI-SESSION-READER-PROOF complete.' }])
    expect(full.ending.status).toBe('open')
    // An explicit recorded error remains a failed ending, independently of usage/response text.
    const failed = readSessionInput('gemini', { records: [...records, { id: 'controlled-recorded-error', type: 'error', timestamp: '2026-11-15T05:42:54Z', content: 'HTTP 429 controlled failure' }] }, { nativeSessionId: nativeId })
    expect(failed.ending).toMatchObject({ status: 'error', error: { httpStatus: 429, message: 'HTTP 429 controlled failure' } })
  })

  it('keeps the real producer\'s defaulted usage channels unknown', async () => {
    // Same actual CLI/tool exchange with only promptTokenCount returned by the
    // local provider. Gemini writes every absent channel as zero, including cache.
    const text = await readFile(join(import.meta.dirname, 'fixtures/gemini/native-0.68.0-partial-usage.jsonl'), 'utf8')
    const session = readSessionInput('gemini', { text }, { nativeSessionId: nativeId })
    expect(session.modelCalls).toHaveLength(2)
    expect(session.modelCalls.every(call => call.usage === null)).toBe(true)
    expect(session.usage).toBeNull()
    expect(session.ending.status).toBe('open')
    const records = text.trim().split('\n').map(line => JSON.parse(line))
    for (const row of records) if (row.type === 'gemini') row.tokens.output = 20
    const partial = readSessionInput('gemini', { records })
    expect(partial.modelCalls[0]?.usage).toEqual({ input: null, output: 20, reasoning: null, cacheRead: null, cacheWrite: null })
    expect(partial.usage?.output).toBe(40)
  })
})
