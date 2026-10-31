import { isRecord } from '@tangle-network/agent-core'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { SessionBuilder, count, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, Part, ReadOptions, SessionRef, TokenUsage } from '../schema.js'
import { fileRecords, isMissing, type RecordSource } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { runFold, type SessionFold } from './fold.js'

const FORMAT = 'grok.acp-session-dir' as const
const STORE = STORES[FORMAT]
const HARNESS = 'grok'
const callId = (id: string) => `${id}:model`

function textBlocks(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textBlocks).filter(Boolean).join('')
  return isRecord(value) ? str(value.text) ?? textBlocks(value.content) : ''
}

function usageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const bag = isRecord(value.usage) ? value.usage : isRecord(value.session) ? value.session : value
  return usageOrNull({
    input: count(bag.input_tokens ?? bag.inputTokens ?? bag.prompt_tokens),
    output: count(bag.output_tokens ?? bag.outputTokens ?? bag.completion_tokens),
    reasoning: count(bag.reasoning_tokens ?? bag.reasoningTokens),
    cacheRead: count(bag.cache_read_tokens ?? bag.cacheReadTokens),
    cacheWrite: count(bag.cache_write_tokens ?? bag.cacheCreationTokens),
  })
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (isMissing(error) || error instanceof SyntaxError) return null; throw error }
}

function createFold(ref: SessionRef, mode: BuildMode, stats: { line: number }, model: string | null, usage: TokenUsage | null): SessionFold {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  let opened = false
  const observe = (record: Record<string, unknown>): void => {
    const update = isRecord(record.update) ? record.update : record
    const kind = str(update.sessionUpdate)
    if (!kind) return
    const at = builder.seen(update.timestamp ?? record.timestamp)
    const id = str(update.toolCallId) ?? `${builder.nativeSessionId}:${stats.line}`
    if (kind === 'user_message_chunk') {
      const text = textBlocks(update.content)
      if (text) builder.message({ id, role: 'user', actor: 'human', at, modelCallId: null, parts: [{ type: 'text', text }] })
      return
    }
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      if (!opened) builder.modelCall({ id: callId(builder.nativeSessionId), at, provider: null, servedModel: model, requestedModel: model, usage, costUsd: null, stopReason: null, error: null })
      opened = true
      const text = textBlocks(update.content)
      const parts: Part[] = kind === 'agent_thought_chunk' ? [{ type: 'reasoning', text, redacted: text.length === 0 }] : [{ type: 'text', text }]
      if (text || kind === 'agent_thought_chunk') builder.message({ id, role: 'assistant', actor: 'agent', at, modelCallId: callId(builder.nativeSessionId), parts })
      return
    }
    if (kind === 'tool_call' && typeof update.toolCallId === 'string') {
      builder.toolCall({ id: update.toolCallId, name: str(update.title) ?? str(update.kind) ?? 'unknown', input: update.rawInput ?? null, inputText: null, at, messageId: id })
      builder.message({ id, role: 'assistant', actor: 'agent', at, modelCallId: callId(builder.nativeSessionId), parts: [{ type: 'tool-call', toolCallId: update.toolCallId }] })
      return
    }
    if (kind === 'tool_call_update' && typeof update.toolCallId === 'string') {
      builder.toolResult(update.toolCallId, { output: update.rawOutput ?? update.content ?? null, text: textOf(update.rawOutput ?? update.content), isError: update.status === 'failed', at, messageId: `${id}:tool` })
      builder.message({ id: `${id}:tool`, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: update.toolCallId }] })
    }
  }
  return { builder, observe, finish: () => { builder.source(stats); builder.inferEnding(); return builder } }
}

async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions): Promise<SessionBuilder> {
  const records = fileRecords(ref.path, { strict: options.corruption === 'strict', signal: options.signal })
  const dir = dirname(ref.path)
  const summary = await readJson(join(dir, 'summary.json'))
  const model = isRecord(summary) ? str(summary.current_model_id) : null
  return runFold(createFold(ref, mode, records.stats, model, usageOf(await readJson(join(dir, 'signals.json')))), records)
}

export const grokReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['grok-build'],
  formats: [FORMAT],
  stores: [STORE],
  globs: { session: STORE.files[0] },
  evidence: EVIDENCE[FORMAT],
  async locate(home, opts = {}) {
    const root = join(home, STORE.root)
    const pattern = storeGlob(STORE.files[0], opts.nativeSessionId)
    const refs: SessionRef[] = []
    for (const rel of await walkFiles(root)) {
      if (!pattern.test(rel)) continue
      const path = join(root, rel)
      const mtime = await mtimeMs(path)
      const id = basename(dirname(rel))
      if ((opts.sinceMs && mtime < opts.sinceMs) || (opts.nativeSessionId && id !== opts.nativeSessionId)) continue
      refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path], home, cwd: null, mtimeMs: mtime, parentNativeSessionId: null })
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  },
  async read(ref, opts = {}) { return (await fold(ref, 'full', opts)).build() },
  async summarize(ref, opts = {}) { return (await fold(ref, 'summary', opts)).summary() },
}

export function grokRefForFile(path: string): SessionRef {
  return { harness: HARNESS, format: FORMAT, nativeSessionId: basename(dirname(path)), path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null }
}
