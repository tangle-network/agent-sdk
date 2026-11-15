import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import {
  assertStoreRoot, captureOpenCodeSessionStore, opencodeReader, opencodeSessionsInStore, readBoundHarnessSessions,
  readOpenCodeSessionSnapshot, toChatMessages, toTurns,
} from '../src/index.js'

const fixtures = join(import.meta.dirname, 'fixtures/opencode2')
const provenance = JSON.parse(readFileSync(join(fixtures, 'provenance.json'), 'utf8'))
const success = provenance.fixtures[0] as { fixture: string; fixtureSha256: string; nativeSessionId: string }
const quota = provenance.fixtures[1] as typeof success
const usage = { input: 180, output: 120, reasoning: 8, cacheRead: 20, cacheWrite: null }

async function changed(change: (db: DatabaseSync) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'opencode2-native-prefix-'))
  try {
    const path = join(dir, 'sessions.db')
    await copyFile(join(fixtures, success.fixture), path)
    const db = new DatabaseSync(path)
    try { change(db) } finally { db.close() }
    const [ref] = await opencodeSessionsInStore(path, null)
    return await opencodeReader.read(ref!)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

it('reads actual OpenCode2.3 responses and tool calls identically from native store, summary and captured bytes', async () => {
  const path = join(fixtures, success.fixture)
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(success.fixtureSha256)
  const refs = await opencodeSessionsInStore(path, null)
  expect(refs.map(ref => ref.nativeSessionId)).toEqual([success.nativeSessionId])
  const session = await opencodeReader.read(refs[0]!)
  const summary = await opencodeReader.summarize(refs[0]!)
  expect(session.messages.map(message => [message.role, message.actor])).toEqual([
    ['user', 'human'], ['assistant', 'agent'], ['tool', 'tool-result'],
    ['assistant', 'agent'], ['tool', 'tool-result'], ['assistant', 'agent'], ['tool', 'tool-result'], ['assistant', 'agent'],
  ])
  expect(session.modelCalls.map(call => [call.requestedModel, call.servedModel, call.usage, call.costUsd, call.stopReason])).toEqual([
    ['glm-5.3-flash-free', null, usage, null, 'tool-calls'],
    ['glm-5.3-flash-free', null, usage, null, 'tool-calls'],
    ['glm-5.3-flash-free', null, usage, null, 'tool-calls'],
    ['glm-5.3-flash-free', null, usage, null, 'stop'],
  ])
  expect(session.toolCalls.map(call => [call.id, call.name, call.status, call.input, call.result?.text])).toEqual([
    ['packed-skill-1', 'skill', 'completed', { id: 'agent-graphs' }, '[REDACTED:fixture-content]'],
    ['packed-skill-2', 'skill', 'completed', { id: 'graph-designer' }, '[REDACTED:fixture-content]'],
    ['packed-skill-3', 'skill', 'completed', { id: 'be-ambitious' }, '[REDACTED:fixture-content]'],
  ])
  expect(session.modelSource).toBe('turn-context')
  expect(session.servedModels).toEqual({})
  expect(session.usage).toEqual({ input: 720, output: 480, reasoning: 32, cacheRead: 80, cacheWrite: null })
  expect(session.ending).toEqual({ status: 'completed', at: '2026-11-15T01:02:03.455Z', error: null })
  expect(session.integrity).toMatchObject({ truncated: false, gaps: [], unparsedRecords: 0 })
  expect(summary).toMatchObject({ modelCalls: 4, replies: 4, toolCalls: 3, usage: session.usage, ending: session.ending, lastServedModel: null, modelSource: 'turn-context' })
  expect(toChatMessages(session).map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
  expect(toTurns(session).filter(turn => turn.role === 'assistant').map(turn => [turn.model, turn.usage])).toEqual(Array.from({ length: 4 }, () => [undefined, usage]))

  const captured = await captureOpenCodeSessionStore(path, [success.nativeSessionId])
  expect(captured.nativeSessionIds).toEqual([success.nativeSessionId])
  const retained = await readOpenCodeSessionSnapshot(captured.bytes, success.nativeSessionId)
  expect(retained.messages).toEqual(session.messages)
  expect(retained.modelCalls).toEqual(session.modelCalls)
  expect(retained.toolCalls).toEqual(session.toolCalls)
  expect(retained.ending).toEqual(session.ending)
  expect(retained.integrity.sourceFiles[0]!.sha256).toEqual(session.integrity.sourceFiles[0]!.sha256)
})

it('preserves the actual429 ending without inventing zero usage, billed cost or a served model', async () => {
  const bytes = await readFile(join(fixtures, quota.fixture))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(quota.fixtureSha256)
  const session = await readOpenCodeSessionSnapshot(bytes, quota.nativeSessionId)
  expect(session.modelCalls).toHaveLength(1)
  expect(session.modelCalls[0]).toMatchObject({ requestedModel: 'glm-5.3-flash-free', servedModel: null, costUsd: null, usage: null, stopReason: 'error', error: { kind: 'provider.free-limit', httpStatus: 429 } })
  expect(session.usage).toBeNull()
  expect(session.servedModels).toEqual({})
  const [ref] = await opencodeSessionsInStore(join(fixtures, quota.fixture), null)
  expect(await opencodeReader.summarize(ref!)).toMatchObject({ modelCalls: 1, replies: 0, usage: null })
  expect(session.ending).toMatchObject({ status: 'error', at: '2026-11-15T00:19:59.944Z', error: { kind: 'provider.free-limit', httpStatus: 429, message: 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.' } })
  const family = await readBoundHarnessSessions({
    nativeSessionId: quota.nativeSessionId,
    files: [{ path: 'native/quota.db', nativeSessionId: quota.nativeSessionId, sha256: quota.fixtureSha256, byteLength: bytes.length }],
    read: async () => bytes, validatePath: assertStoreRoot,
    parseBytes: (raw, file) => readOpenCodeSessionSnapshot(raw, file.nativeSessionId, { label: file.path }),
  })
  expect(family.sessions).toHaveLength(1)
  expect(family.sessions[0]).toMatchObject({ usage: null, ending: { status: 'error', error: { httpStatus: 429 } }, integrity: { gaps: [] } })
})

it('uses native sequence and part ordinal order, including parts before retained inline content', async () => {
  const session = await changed(db => {
    const toolRow = db.prepare("SELECT * FROM session_message WHERE type = 'assistant' ORDER BY seq LIMIT 1").get()!
    const toolData = JSON.parse(String(toolRow.data)), tool = toolData.content.shift()
    db.prepare('INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)').run(String(toolRow.id), success.nativeSessionId, 0, 'tool', tool.id, Number(toolRow.time_created), Number(toolRow.time_updated), JSON.stringify(tool))
    db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify(toolData), String(toolRow.id))
    // The native projection can move a response's prefix to session_part while keeping its tail inline.
    const row = db.prepare("SELECT * FROM session_message WHERE type = 'assistant' ORDER BY seq DESC LIMIT 1").get()!
    const data = JSON.parse(String(row.data))
    const text: string = data.content[0].text
    const prefix = [text.slice(0, 8), text.slice(8, 16)]
    for (const ordinal of [1, 0]) db.prepare('INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)').run(
      String(row.id), success.nativeSessionId, ordinal, 'text', null, Number(row.time_created), Number(row.time_updated), JSON.stringify({ type: 'text', text: prefix[ordinal] }),
    )
    data.content[0].text = text.slice(16)
    db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify(data), String(row.id))
    // Capture/update timestamps are not the conversation order; seq remains authoritative.
    db.prepare("UPDATE session_message SET time_created = time_created + 100000 WHERE type = 'user'").run()
  })
  expect(session.messages[0]).toMatchObject({ role: 'user', actor: 'human' })
  expect(session.messages.at(-1)!.parts).toEqual([
    { type: 'text', text: '[REDACTE' }, { type: 'text', text: 'D:fixtur' }, { type: 'text', text: 'e-content]' },
  ])
  expect(session.modelCalls).toHaveLength(4)
  expect(session.toolCalls[0]).toMatchObject({ id: 'packed-skill-1', name: 'skill', status: 'completed', input: { id: 'agent-graphs' } })
  expect(session.usage).toEqual({ input: 720, output: 480, reasoning: 32, cacheRead: 80, cacheWrite: null })
})

it('keeps unfinished and resumed native turns open even when an earlier response or idle marker looks complete', async () => {
  const prefix = await changed(db => { db.prepare("DELETE FROM session_message WHERE type = 'idle'").run() })
  expect(prefix.modelCalls).toHaveLength(4)
  expect(prefix.ending).toEqual({ status: 'open', error: null, at: null })
  const resumed = await changed(db => { db.prepare('UPDATE session_v2 SET time_busy = time_idle + 1').run() })
  expect(resumed.ending.status).toBe('open')
  const steered = await changed(db => {
    db.prepare("INSERT INTO session_message SELECT 'msg_new_prompt',session_id,type,999,time_created,time_updated,data FROM session_message WHERE type = 'user'").run()
  })
  expect(steered.ending.status).toBe('open')
  const interrupted = await changed(db => {
    const row = db.prepare("SELECT id,data FROM session_message WHERE type = 'idle'").get()!
    const data = JSON.parse(String(row.data)); data.outcome = 'interrupted'
    db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify(data), String(row.id))
    db.prepare("UPDATE session_v2 SET idle_outcome = 'interrupted'").run()
  })
  expect(interrupted.ending).toEqual({ status: 'aborted', at: '2026-11-15T01:02:03.455Z', error: null })
})

it('keeps zero placeholders and counters inherited by pending or failed attempts unknown', async () => {
  const zero = await changed(db => {
    for (const row of db.prepare("SELECT id,data FROM session_message WHERE type = 'assistant'").all()) {
      const data = JSON.parse(String(row.data))
      data.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify(data), String(row.id))
    }
  })
  expect(zero.modelCalls.every(call => call.usage === null)).toBe(true)
  expect(zero.usage).toBeNull()
  const partial = await changed(db => {
    for (const row of db.prepare("SELECT id,data FROM session_message WHERE type = 'assistant'").all()) {
      const data = JSON.parse(String(row.data))
      data.tokens = { input: 7, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify(data), String(row.id))
    }
  })
  expect(partial.modelCalls[0]!.usage).toEqual({ input: 7, output: null, reasoning: null, cacheRead: null, cacheWrite: null })
  expect(partial.usage).toEqual({ input: 28, output: null, reasoning: null, cacheRead: null, cacheWrite: null })
  const pending = await changed(db => {
    const row = db.prepare("SELECT id,seq,data FROM session_message WHERE type = 'assistant' ORDER BY seq LIMIT 1").get()!
    db.prepare('DELETE FROM session_message WHERE seq > ?').run(Number(row.seq))
    const data = JSON.parse(String(row.data))
    delete data.finish; delete data.time.completed
    db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify(data), String(row.id))
  })
  expect(pending.modelCalls).toHaveLength(1)
  expect(pending.usage).toBeNull()
  expect(pending.ending.status).toBe('open')
  expect(pending.integrity.gaps).toEqual([])
  const failed = await changed(db => {
    const row = db.prepare("SELECT id,seq,data FROM session_message WHERE type = 'assistant' ORDER BY seq LIMIT 1").get()!
    db.prepare('DELETE FROM session_message WHERE seq > ?').run(Number(row.seq))
    const data = JSON.parse(String(row.data))
    data.finish = 'error'; data.error = { type: 'provider.failed', message: 'controlled failed attempt with inherited counters', status: 500 }
    db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify(data), String(row.id))
  })
  expect(failed.modelCalls[0]).toMatchObject({ usage: null, error: { kind: 'provider.failed', httpStatus: 500 } })
  expect(failed.usage).toBeNull()
  expect(failed.integrity.gaps).toEqual([])
})
