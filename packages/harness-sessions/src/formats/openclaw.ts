import { basename, join } from 'node:path'
import { isRecord } from '@tangle-network/agent-core'
import { SessionBuilder, str, textOf, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, ReadOptions, SessionRef } from '../schema.js'
import { fileRecords } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { runFold, type SessionFold } from './fold.js'

const FORMAT = 'openclaw.session-jsonl' as const
const STORE = STORES[FORMAT]
const HARNESS = 'openclaw'

function createFold(ref: SessionRef, mode: BuildMode, stats: { line: number }): SessionFold {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  let calls = 0
  const observe = (record: Record<string, unknown>): void => {
    const message = isRecord(record.message) ? record.message : record
    const role = str(message.role) ?? str(record.role)
    const text = textOf(message.content) ?? textOf(message.text) ?? str(message.content)
    const at = builder.seen(record.timestamp ?? message.timestamp)
    const id = str(record.id) ?? `${ref.nativeSessionId}:${stats.line}`
    if (role === 'user' && text) builder.message({ id, role: 'user', actor: 'human', at, modelCallId: null, parts: [{ type: 'text', text }] })
    if (role === 'assistant') {
      const model = str(message.model) ?? str(record.model)
      const modelCallId = `${ref.nativeSessionId}:${calls}`
      builder.modelCall({ id: modelCallId, at, provider: str(record.provider), servedModel: model, requestedModel: model, usage: null, costUsd: null, stopReason: null, error: null })
      calls += 1
      if (text) builder.message({ id, role: 'assistant', actor: 'agent', at, modelCallId, parts: [{ type: 'text', text }] })
    }
  }
  return { builder, observe, finish: () => { builder.inferEnding(); return builder } }
}

export const openclawReader: HarnessSessionReader = {
  harness: HARNESS, aliases: [], formats: [FORMAT], stores: [STORE], globs: { session: STORE.files[0] }, evidence: EVIDENCE[FORMAT],
  async locate(home, opts = {}) {
    const root = join(home, STORE.root)
    const pattern = storeGlob(STORE.files[0], opts.nativeSessionId)
    const refs: SessionRef[] = []
    for (const rel of await walkFiles(root)) {
      if (!pattern.test(rel)) continue
      const path = join(root, rel)
      const id = basename(rel, '.jsonl')
      if (opts.nativeSessionId && id !== opts.nativeSessionId) continue
      refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path], home, cwd: null, mtimeMs: await mtimeMs(path), parentNativeSessionId: null })
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  },
  async read(ref, opts: ReadOptions = {}) {
    const records = fileRecords(ref.path, { strict: opts.corruption === 'strict', signal: opts.signal })
    return (await runFold(createFold(ref, 'full', records.stats), records)).build()
  },
  async summarize(ref, opts: ReadOptions = {}) {
    const records = fileRecords(ref.path, { strict: opts.corruption === 'strict', signal: opts.signal })
    return (await runFold(createFold(ref, 'summary', records.stats), records)).summary()
  },
}
