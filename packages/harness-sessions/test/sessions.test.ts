/**
 * Every fixture here is a session a real harness CLI wrote while it talked to the trace-proof
 * scripted model (beelink1 trace-proof-r2, 2026-10-04): Claude Code 2.1.286, Codex 0.145.0,
 * OpenCode 1.18.25 and Pi 0.85.1. The model's script fixes what each session must hold: two shell
 * tool calls and a final answer, 100 input and 20 output tokens per response. The assertions are
 * that script, read back through each harness's own store.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateTraceSpans } from '@tangle-network/agent-trace-contract'
import {
  claudeCodeReader, claudeCodeRefForFile, codexReader, codexRefForFile, opencodeReader, opencodeSessionsInStore,
  claudeRecordIsMachine, claudeTypedPromptText, piReader, piRefForFile, readerFor, readSessionInput, toChatMessages, toOtlpSpans, toTurns,
  type HarnessSession, type HarnessSessionReader, type SessionRef,
} from '../src/index.js'

const fixture = (...parts: string[]): string => join(import.meta.dirname, 'fixtures', ...parts)
const SCRIPTED = { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

async function both(reader: HarnessSessionReader, ref: SessionRef): Promise<HarnessSession> {
  const session = await reader.read(ref)
  const summary = await reader.summarize(ref)
  // read and summarize are one fold over the same records.
  expect(summary.modelCalls).toBe(session.modelCalls.length)
  expect(summary.toolCalls).toBe(session.toolCalls.length)
  expect(summary.servedModels).toEqual(session.servedModels)
  expect(summary.usage).toEqual(session.usage)
  expect(summary.ending).toEqual(session.ending)
  // The OTLP projection is a contract trace with no error findings.
  const validation = validateTraceSpans(toOtlpSpans(session))
  expect(validation.ok).toBe(true)
  expect(validation.findings.filter((f) => f.severity === 'error')).toEqual([])
  return session
}

describe('Claude Code', () => {
  it('reads a completed scripted turn', async () => {
    const s = await both(claudeCodeReader, claudeCodeRefForFile(fixture('claude-code', 'completed.jsonl')))
    expect(s.nativeSessionId).toBe('0fddd385-d123-4c2c-b9f0-c0d37c529d7e')
    expect(s.modelCalls.map((c) => [c.servedModel, c.usage, c.stopReason])).toEqual([
      ['traceproof-scripted-model', SCRIPTED, 'tool_use'],
      ['traceproof-scripted-model', SCRIPTED, 'tool_use'],
      ['traceproof-scripted-model', SCRIPTED, 'end_turn'],
    ])
    expect(s.toolCalls.map((t) => [t.name, t.status])).toEqual([['Bash', 'completed'], ['Bash', 'completed']])
    expect(String((s.toolCalls[0]!.input as { command: string }).command)).toContain('TRACEPROOF-WORKER-REAP-TOOL-OUTPUT')
    expect(s.toolCalls[0]!.result?.text).toContain('TRACEPROOF-WORKER-REAP-TOOL-OUTPUT')
    expect(s.usage).toEqual({ input: 300, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(s.ending.status).toBe('completed')
    expect(toChatMessages(s).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    expect(toTurns(s).filter((t) => t.role === 'assistant').map((t) => t.model)).toEqual(Array(3).fill('traceproof-scripted-model'))
  })

  it('classifies harness-written user records as injected and a typed slash command as human', async () => {
    // Records shaped as a Claude Code 2.1.286 interactive session writes them (entrypoint cli, no origin field).
    const s = await both(claudeCodeReader, claudeCodeRefForFile(fixture('claude-code', 'machine-records.jsonl')))
    const users = s.messages.filter((m) => m.role === 'user').map((m) => [m.actor, m.parts.map((p) => (p.type === 'text' ? p.text : p.type))])
    expect(users).toEqual([
      ['injected', [expect.stringContaining('<local-command-caveat>')]],
      ['human', ['/effort']],
      ['injected', [expect.stringContaining('<local-command-stdout>')]],
      ['human', ['Rename the helper to parseConfig.']],
    ])
  })

  it('reads a resumed transcript that writes its earlier records again once, with unique span identities', async () => {
    // A resumed agent's file repeats its prefix with the same record uuids and timestamps.
    const s = await both(claudeCodeReader, claudeCodeRefForFile(fixture('claude-code', 'replayed-records.jsonl')))
    expect(s.messages.filter((m) => m.actor === 'human').map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'Summarize the build failure.' }],
      [{ type: 'text', text: 'Try again.' }],
      [{ type: 'text', text: 'Thanks, now fix it.' }],
    ])
    expect(s.modelCalls.map((c) => [c.error ? 'error' : 'ok', c.servedModel])).toEqual([
      ['error', null], ['ok', 'scripted-model'], ['ok', 'scripted-model'],
    ])
    expect(s.integrity.gaps).toEqual([])
    const ids = toOtlpSpans(s).map((span) => span.span_id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves a turn killed during its tool call open with the call pending', async () => {
    const s = await both(claudeCodeReader, claudeCodeRefForFile(fixture('claude-code', 'killed.jsonl')))
    expect(s.modelCalls).toHaveLength(1)
    expect(s.toolCalls.map((t) => t.status)).toEqual(['pending'])
    expect(s.ending).toEqual({ status: 'open', error: null, at: null })
  })
})

describe('Codex', () => {
  it('reads a completed scripted turn; the model is the turn context', async () => {
    const s = await both(codexReader, codexRefForFile(fixture('codex', 'rollout-2026-10-04T21-50-21-01a108e5-81d9-71b0-9cec-e5d33586604f.jsonl')))
    expect(s.modelSource).toBe('turn-context')
    expect(s.modelCalls.map((c) => [c.provider, c.servedModel, c.usage])).toEqual(Array(3).fill(['tangle', 'gpt-5.5', SCRIPTED]))
    expect(s.toolCalls.map((t) => [t.name, t.status])).toEqual([['exec_command', 'completed'], ['exec_command', 'completed']])
    expect(s.usage).toEqual({ input: 300, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(s.ending.status).toBe('completed')
  })
})

describe('OpenCode', () => {
  it('reads the session from the SQLite store', async () => {
    const [ref, ...rest] = await opencodeSessionsInStore(fixture('opencode', 'opencode.db'), null)
    expect(rest).toHaveLength(0)
    const s = await both(opencodeReader, ref!)
    expect(s.modelCalls.map((c) => [c.provider, c.servedModel, c.usage, c.stopReason])).toEqual([
      ['openai-compat', 'openai/gpt-5.5', SCRIPTED, 'tool-calls'],
      ['openai-compat', 'openai/gpt-5.5', SCRIPTED, 'tool-calls'],
      ['openai-compat', 'openai/gpt-5.5', SCRIPTED, 'stop'],
    ])
    expect(s.toolCalls.map((t) => [t.name, t.status])).toEqual([['bash', 'completed'], ['bash', 'completed']])
    expect(s.ending.status).toBe('completed')
  })
})

describe('Pi', () => {
  it('reads a session resumed for a second turn as one session', async () => {
    const s = await both(piReader, piRefForFile(fixture('pi', '2026-10-05T00-42-50-830Z_7b2f3c4e-1d2a-4b5c-8e9f-0a1b2c3d4e5f.jsonl')))
    expect(s.nativeSessionId).toBe('7b2f3c4e-1d2a-4b5c-8e9f-0a1b2c3d4e5f')
    expect(s.modelCalls.map((c) => [c.provider, c.servedModel, c.usage])).toEqual(Array(4).fill(['traceproof', 'traceproof-scripted-model', SCRIPTED]))
    expect(s.messages.filter((m) => m.actor === 'human')).toHaveLength(2)
    // The scripted commands write into a directory the CLI could not write: Pi recorded both results as errors.
    expect(s.toolCalls.map((t) => [t.name, t.status])).toEqual([['bash', 'error'], ['bash', 'error']])
    expect(s.ending.status).toBe('completed')
  })

  it('records a provider failure as failed calls with no served model and an error ending', async () => {
    const s = await both(piReader, piRefForFile(fixture('pi', '2026-10-05T00-42-59-018Z_9c8d7e6f-5a4b-4c3d-9e2f-1a0b9c8d7e6f.jsonl')))
    expect(s.modelCalls).toHaveLength(4)
    expect(s.modelCalls.every((c) => c.servedModel === null && c.requestedModel === 'traceproof-scripted-model' && c.error?.message === 'Connection error.')).toBe(true)
    expect(s.servedModels).toEqual({})
    expect(s.ending.status).toBe('error')
    expect(s.ending.error?.message).toBe('Connection error.')
  })
})

describe('in-memory input', () => {
  it('reads text and parsed records through the same fold as the file', async () => {
    for (const [harness, path, ref] of [
      ['claude-code', fixture('claude-code', 'completed.jsonl'), claudeCodeRefForFile(fixture('claude-code', 'completed.jsonl'))],
      ['codex', fixture('codex', 'rollout-2026-10-04T21-50-21-01a108e5-81d9-71b0-9cec-e5d33586604f.jsonl'), codexRefForFile(fixture('codex', 'rollout-2026-10-04T21-50-21-01a108e5-81d9-71b0-9cec-e5d33586604f.jsonl'))],
      ['pi', fixture('pi', '2026-10-05T00-42-50-830Z_7b2f3c4e-1d2a-4b5c-8e9f-0a1b2c3d4e5f.jsonl'), piRefForFile(fixture('pi', '2026-10-05T00-42-50-830Z_7b2f3c4e-1d2a-4b5c-8e9f-0a1b2c3d4e5f.jsonl'))],
    ] as const) {
      const text = readFileSync(path, 'utf8')
      const fromFile = await readerFor(harness).read(ref)
      const fromText = await readSessionInput(harness, { text })
      const fromRecords = await readSessionInput(harness, { records: text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) })
      for (const other of [fromText, fromRecords]) {
        expect(other.nativeSessionId).toBe(fromFile.nativeSessionId)
        expect(other.messages).toEqual(fromFile.messages)
        expect(other.toolCalls).toEqual(fromFile.toolCalls)
        expect(other.modelCalls).toEqual(fromFile.modelCalls)
        expect(other.ending).toEqual(fromFile.ending)
      }
      expect(fromText.integrity.sourceFiles[0]!.sha256).toBe(fromFile.integrity.sourceFiles[0]!.sha256)
    }
  })
})

describe('registry', () => {
  it('resolves harness aliases and refuses an unknown harness', () => {
    expect(readerFor('claude').harness).toBe('claude-code')
    expect(readerFor('codex-acp').harness).toBe('codex')
    expect(() => readerFor('no-such-harness')).toThrow(/no session reader/)
  })
})

describe('Claude Code record rules', () => {
  it('names harness-written records and recovers typed commands', () => {
    expect(claudeRecordIsMachine({ text: 'hi', isMeta: true })).toBe(true)
    expect(claudeRecordIsMachine({ text: 'hi', isCompactSummary: true })).toBe(true)
    expect(claudeRecordIsMachine({ text: 'hi', entrypoint: 'sdk-cli' })).toBe(true)
    expect(claudeRecordIsMachine({ text: '  <task-notification>x' })).toBe(true)
    expect(claudeRecordIsMachine({ text: '[Request interrupted by user for tool use]' })).toBe(true)
    expect(claudeRecordIsMachine({ text: '<command-name>/model</command-name>', entrypoint: 'cli' })).toBe(false)
    expect(claudeRecordIsMachine({ text: '<bash-input>ls</bash-input>' })).toBe(false)
    expect(claudeTypedPromptText('<command-name>/model</command-name><command-args>opus</command-args>')).toBe('/model opus')
    expect(claudeTypedPromptText('plain text')).toBe('plain text')
  })
})

describe('a session read in parts', () => {
  it('names a record without an id by its file line, whichever part of the file is read', () => {
    const id = '01a10000-0000-7000-8000-000000000001'
    const rows = [
      { timestamp: '2026-10-16T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/w' } },
      { timestamp: '2026-10-16T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First.' }] } },
      { timestamp: '2026-10-16T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second.' }] } },
    ]
    const users = (input: Parameters<typeof readSessionInput>[1], firstLine?: number): string[] =>
      readSessionInput('codex', input, { nativeSessionId: id, ...(firstLine === undefined ? {} : { firstLine }) })
        .messages.filter((message) => message.role === 'user').map((message) => message.id)
    const whole = users({ text: `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` })
    expect(whole).toHaveLength(2)
    // The last line alone, as text and as parsed records, read as starting on line 3.
    expect(users({ text: `${JSON.stringify(rows[2])}\n` }, 3)).toEqual([whole[1]])
    expect(users({ records: [rows[2]] }, 3)).toEqual([whole[1]])
  })
})
