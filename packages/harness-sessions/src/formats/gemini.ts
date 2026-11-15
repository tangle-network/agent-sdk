import { isRecord } from '@tangle-network/agent-core'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SessionBuilder, count, sessionError, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import { BOUND_HARNESS_SESSION_READ_LIMITS } from '../bounded-family.js'
import { readHeldSessionFile } from '../declared-files.js'
import type { HarnessSessionReader, Part, ReadOptions, SessionRef } from '../schema.js'
import { memoryStats, textRecordsSync, type SourceStats } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, walkFiles } from '../stores.js'
import type { SessionFold } from './fold.js'

const HARNESS = 'gemini'
const FORMATS = ['gemini.chat-json', 'gemini.chat-jsonl'] as const

export function geminiInputFormat(input: string | readonly unknown[]): (typeof FORMATS)[number] {
  let first: unknown
  if (typeof input === 'string') { try { first = JSON.parse(input) } catch { return FORMATS[1] } }
  else first = input[0]
  return isRecord(first) && Array.isArray(first.messages) ? FORMATS[0] : FORMATS[1]
}

/** Gemini's rewritten JSON and append log carry the same conversation records. */
export function* geminiRecords(text: string, stats: SourceStats, options: { strict?: boolean; firstLine?: number } = {}): Generator<Record<string, unknown>> {
  let record: unknown
  try { record = JSON.parse(text) } catch { /* An append log has more than one JSON value. */ }
  if (isRecord(record)) {
    stats.line = 1
    yield record
  } else yield* textRecordsSync(text, stats, options)
}

function partsOf(value: unknown, id: string): Part[] {
  const parts: Part[] = []
  for (const part of Array.isArray(value) ? value : [value]) {
    if (typeof part === 'string') parts.push({ type: 'text', text: part })
    else if (isRecord(part)) {
      if (typeof part.text === 'string') parts.push({ type: 'text', text: part.text })
      else if (isRecord(part.inlineData)) parts.push({ type: 'attachment', mediaType: str(part.inlineData.mimeType) ?? 'file', ref: `inline:${id}` })
      else if (isRecord(part.fileData)) parts.push({ type: 'attachment', mediaType: str(part.fileData.mimeType) ?? 'file', ref: str(part.fileData.fileUri) ?? id })
    }
  }
  return parts
}

function responsesOf(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value]).filter(isRecord).map(part => part.functionResponse).filter(isRecord)
}

function resultText(value: unknown): string | null {
  return textOf(value) ?? (responsesOf(value).map(response => isRecord(response.response) ? str(response.response.output) : null).filter(text => text !== null).join('\n') || null)
}

export function createFold(ref: SessionRef, mode: BuildMode, stats: SourceStats): SessionFold {
  const format = ref.format === FORMATS[1] ? FORMATS[1] : FORMATS[0]
  const builder = new SessionBuilder(HARNESS, format, EVIDENCE[format].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  const messages = new Map<string, Record<string, unknown>>()
  let metadata: Record<string, unknown> = {}
  let changedHistory = false
  const message = (value: unknown): void => {
    if (isRecord(value) && typeof value.id === 'string') messages.set(value.id, structuredClone(value))
    else stats.unparsed += 1
  }
  const patchMessage = (patch: unknown): void => {
    if (!isRecord(patch) || typeof patch.id !== 'string') return
    const existing = messages.get(patch.id)
    if (!existing) return
    if ('content' in patch) existing.content = patch.content
    for (const update of Array.isArray(patch.toolCalls) ? patch.toolCalls : []) {
      if (!isRecord(update) || !('result' in update) || !Array.isArray(existing.toolCalls)) continue
      const tool = existing.toolCalls.find(value => isRecord(value) && value.id === update.id)
      if (isRecord(tool)) tool.result = update.result
    }
  }
  const observe = (record: Record<string, unknown>): void => {
    if (typeof record.$rewindTo === 'string') {
      changedHistory = true
      const ids = [...messages.keys()]
      const index = ids.indexOf(record.$rewindTo)
      for (const id of index < 0 ? ids : ids.slice(index)) messages.delete(id)
    } else if (isRecord(record.$patch)) {
      const patch = record.$patch
      patchMessage(patch)
      for (const update of Array.isArray(patch.updates) ? patch.updates : []) patchMessage(update)
      for (const id of Array.isArray(patch.removeIds) ? patch.removeIds : []) {
        if (typeof id === 'string') { messages.delete(id); changedHistory = true }
      }
      if (Array.isArray(patch.orderIds)) {
        const tail = patch.orderIds.filter((id): id is string => typeof id === 'string' && messages.has(id)).map(id => [id, messages.get(id)!] as const)
        for (const [id] of tail) messages.delete(id)
        for (const [id, value] of tail) messages.set(id, value)
      }
    } else if (typeof record.id === 'string') message(record)
    else if (isRecord(record.$set) || typeof record.sessionId === 'string') {
      const update = isRecord(record.$set) ? record.$set : record
      if (metadata.sessionId && update.sessionId && metadata.sessionId !== update.sessionId) builder.gap('Gemini log changes its recorded session identity')
      if (Array.isArray(update.messages)) {
        if (isRecord(record.$set)) { messages.clear(); changedHistory = true }
        for (const item of update.messages) message(item)
      }
      metadata = { ...metadata, ...update }
    } else stats.unparsed += 1
  }
  const finish = (): SessionBuilder => {
    const id = str(metadata.sessionId)
    if (!id || !str(metadata.projectHash)) builder.gap('Gemini conversation header is missing its sessionId or projectHash')
    if (ref.nativeSessionId && id !== ref.nativeSessionId) builder.gap('Gemini header does not match the bound native session')
    builder.nativeSessionId = id ?? ref.nativeSessionId
    if (ref.cwd && metadata.projectHash !== createHash('sha256').update(ref.cwd).digest('hex')) builder.gap('Gemini project hash does not match the bound workspace')
    builder.cwd = ref.cwd
    builder.seen(metadata.startTime)
    builder.seen(metadata.lastUpdated)
    const recordedResults = new Set([...messages.values()].flatMap(item => item.type === 'user' ? responsesOf(item.content).map(result => str(result.id)).filter(id => id !== null) : []))
    const emittedResults = new Set<string>()
    const toolStatus = new Map<string, unknown>()
    let endingError: ReturnType<typeof sessionError> | null = null
    for (const [messageId, item] of messages) {
      const at = builder.seen(item.timestamp)
      const parts = partsOf(item.content, messageId)
      if (item.type !== 'gemini') {
        if (!['user', 'info', 'warning', 'error'].includes(String(item.type))) { stats.unparsed += 1; continue }
        if (item.type === 'user') endingError = null
        if (item.type === 'user') for (const result of responsesOf(item.content)) {
          const toolId = str(result.id)
          if (!toolId) { stats.unparsed += 1; continue }
          if (emittedResults.has(toolId)) continue
          emittedResults.add(toolId)
          builder.message({ id: `${messageId}:${toolId}`, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: toolId }] })
          builder.toolResult(toolId, { output: result.response ?? null, text: isRecord(result.response) ? str(result.response.output) : null, isError: toolStatus.get(toolId) === 'error' || toolStatus.get(toolId) === 'cancelled' || (isRecord(result.response) && Boolean(result.response.error)), at, messageId: `${messageId}:${toolId}` })
        }
        if (item.type === 'user' && !parts.length) continue
        if (item.type === 'error') endingError = sessionError('error', textOf(item.content) ?? parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), at)
        const injected = parts.some(part => part.type === 'text' && /^<(?:session|hook)_context>/u.test(part.text.trim()))
        builder.message({ id: messageId, role: item.type === 'user' ? 'user' : 'system', actor: item.type === 'user' && !injected ? (ref.parentNativeSessionId ? 'subagent-spawn' : 'human') : 'injected', at, modelCallId: null, parts })
        continue
      }
      endingError = null
      for (const thought of Array.isArray(item.thoughts) ? item.thoughts : []) if (isRecord(thought)) {
        parts.push({ type: 'reasoning', text: [str(thought.subject), str(thought.description)].filter(Boolean).join('\n'), redacted: false })
      }
      const tokens = isRecord(item.tokens) ? item.tokens : {}
      // ChatRecordingService normalizes every missing provider channel to zero.
      // Its persisted zero therefore cannot distinguish absence from a measurement.
      const measured = (value: unknown): number | null => { const n = count(value); return n !== null && n > 0 ? n : null }
      const prompt = measured(tokens.input), cached = measured(tokens.cached)
      if (prompt !== null && cached !== null && cached > prompt) builder.gap('Gemini cached tokens exceed the recorded prompt count')
      // The real CLI writes its requested model here even when the response modelVersion differs.
      builder.modelCall({ id: messageId, at, provider: null, servedModel: null, requestedModel: str(item.model), usage: usageOrNull({ input: prompt !== null && cached !== null && cached <= prompt ? prompt - cached : null, output: measured(tokens.output), reasoning: measured(tokens.thoughts), cacheRead: cached, cacheWrite: null }), costUsd: null, stopReason: null, error: null })
      const tools = (Array.isArray(item.toolCalls) ? item.toolCalls : []).filter(isRecord)
      for (const tool of tools) {
        const toolId = str(tool.id)
        if (!toolId) { stats.unparsed += 1; continue }
        toolStatus.set(toolId, tool.status)
        parts.push({ type: 'tool-call', toolCallId: toolId })
        builder.toolCall({ id: toolId, name: str(tool.name) ?? 'unknown', input: tool.args ?? null, inputText: null, at: builder.seen(tool.timestamp) ?? at, messageId })
      }
      const replied = parts.some(part => part.type === 'tool-call' || ((part.type === 'text' || part.type === 'reasoning') && part.text.length > 0))
      builder.message({ id: messageId, role: 'assistant', actor: replied ? 'agent' : 'injected', at, modelCallId: messageId, parts })
      for (const tool of tools) if (typeof tool.id === 'string' && !recordedResults.has(tool.id) && !emittedResults.has(tool.id) && ['success', 'error', 'cancelled'].includes(String(tool.status))) {
        emittedResults.add(tool.id)
        const resultId = `${tool.id}:result`
        const toolAt = builder.seen(tool.timestamp) ?? at
        builder.message({ id: resultId, role: 'tool', actor: 'tool-result', at: toolAt, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: tool.id }] })
        builder.toolResult(tool.id, { output: tool.result ?? null, text: resultText(tool.result), isError: tool.status !== 'success', at: toolAt, messageId: resultId, details: { status: tool.status } })
      }
    }
    builder.source(stats)
    if (changedHistory) builder.gap('Gemini rewound or replaced history; messages and usage cover the retained conversation only')
    if (ref.truncated) builder.markTruncated(`${ref.path}: the conversation copy was cut short`)
    // The recorder writes response text before tool-call updates and has no native turn-end
    // marker. Even a final-looking assistant can be a killed prefix; transport owns completion.
    if (endingError) builder.end({ status: 'error', at: endingError.at, error: endingError })
    return builder
  }
  return { builder, observe, finish }
}

export function geminiRefForFile(path: string, nativeSessionId = ''): SessionRef {
  return { harness: HARNESS, format: path.endsWith('.jsonl') ? FORMATS[1] : FORMATS[0], nativeSessionId, path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null }
}

async function readText(path: string, options: ReadOptions): Promise<string> {
  options.signal?.throwIfAborted()
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') throw new Error('Safe Gemini reads require O_NOFOLLOW and O_NONBLOCK')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(await readHeldSessionFile(file, BOUND_HARNESS_SESSION_READ_LIMITS.maxTotalBytes, options.signal)) }
  finally { await file.close() }
}

async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions): Promise<SessionBuilder> {
  const text = await readText(ref.path, options)
  const stats = memoryStats(ref.path, text)
  const result = createFold(ref, mode, stats)
  for (const record of geminiRecords(text, stats, { strict: options.corruption === 'strict' })) result.observe(record)
  return result.finish()
}

export const geminiReader: HarnessSessionReader = {
  harness: HARNESS, aliases: ['gemini-cli'], formats: FORMATS,
  stores: FORMATS.map(format => STORES[format]), globs: { session: '*/chats/session-*.json*' }, evidence: EVIDENCE[FORMATS[0]],
  async locate(home, options = {}) {
    const root = join(home, STORES[FORMATS[0]].root)
    const refs: SessionRef[] = []
    for (const path of await walkFiles(root, undefined, rel => /^[^/]+\/chats\/session-[^/]+\.jsonl?$/u.test(rel))) {
      const ref = { ...geminiRefForFile(join(root, path)), home, mtimeMs: await mtimeMs(join(root, path)) }
      if (options.sinceMs && ref.mtimeMs < options.sinceMs) continue
      const text = await readText(ref.path, {})
      const header = geminiRecords(text, memoryStats(ref.path, text), { strict: true }).next().value
      if (!header || !str(header.sessionId) || !str(header.projectHash)) continue
      if (options.nativeSessionId && options.nativeSessionId !== header.sessionId) continue
      ref.nativeSessionId = header.sessionId as string
      if (options.cwd) {
        ref.cwd = resolve(options.cwd)
        if (header.projectHash !== createHash('sha256').update(ref.cwd).digest('hex')) continue
      }
      refs.push(ref)
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  },
  read: async (ref, options = {}) => (await fold(ref, 'full', options)).build(),
  summarize: async (ref, options = {}) => (await fold(ref, 'summary', options)).summary(),
}
