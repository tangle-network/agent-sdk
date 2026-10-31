import { isRecord } from '@tangle-network/agent-core'
import { basename, join } from 'node:path'
import { SessionBuilder, count, sessionError, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSession, HarnessSessionReader, LocateOptions, Part, ReadOptions, SessionRef, SessionSummary, TokenUsage } from '../schema.js'
import { fileRecords, type RecordSource, type SourceStats } from '../source.js'
import { runFold, type SessionFold } from './fold.js'
import { EVIDENCE, LOCATE_READS, STORES, mapLimit, mtimeMs, storeGlob, walkFiles, withinPath } from '../stores.js'
import { headRecord } from './head.js'
import { claudeRecordIsMachine, claudeTypedPromptText } from './claude-records.js'

const FORMAT = 'claude-code.projects-jsonl' as const
const STORE = STORES[FORMAT]
const HARNESS = 'claude-code'

function usageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const details = isRecord(value.output_tokens_details) ? value.output_tokens_details : {}
  return usageOrNull({
    input: count(value.input_tokens),
    output: count(value.output_tokens),
    reasoning: count(details.thinking_tokens),
    cacheRead: count(value.cache_read_input_tokens),
    cacheWrite: count(value.cache_creation_input_tokens),
  })
}

function firstText(parts: Part[]): string {
  for (const part of parts) if (part.type === 'text') return part.text
  return ''
}

const INTERRUPTED = /^\[Request interrupted by user/u

export function createFold(ref: SessionRef, mode: BuildMode, stats: SourceStats): SessionFold {
  const subagent = ref.parentNativeSessionId !== null
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  let sidechainSkipped = 0
  let aborted: { at: string | null } | null = null
  let errors = 0
  let identified = false
  const seenUuids = new Set<string>()

  const observe = (record: Record<string, unknown>): void => {
    if (!subagent && record.isSidechain === true) {
      sidechainSkipped += 1
      return
    }
    const type = record.type
    if (type !== 'user' && type !== 'assistant' && type !== 'system') return
    if (typeof record.uuid === 'string') {
      if (seenUuids.has(record.uuid)) return
      seenUuids.add(record.uuid)
    }
    const at = builder.seen(record.timestamp)
    if (builder.cwd === null && typeof record.cwd === 'string') builder.cwd = record.cwd
    if (!identified && typeof record.sessionId === 'string') {
      identified = true
      if (subagent && typeof record.agentId === 'string') {
        builder.nativeSessionId = record.agentId
        builder.parentNativeSessionId = record.sessionId
      } else if (!subagent) {
        builder.nativeSessionId = record.sessionId
      }
    }
    const uuid = str(record.uuid) ?? `${builder.nativeSessionId}:${stats.line}`
    const machine = (text: string): boolean =>
      claudeRecordIsMachine({ text, isMeta: record.isMeta === true, isCompactSummary: record.isCompactSummary === true, entrypoint: str(record.entrypoint) ?? undefined })

    if (type === 'system') {
      if (record.subtype !== 'api_error') return
      const error = isRecord(record.error) ? record.error : {}
      const message = str(error.formatted) ?? str(error.message) ?? str(record.content) ?? 'API error'
      builder.modelCall({
        id: uuid,
        at,
        provider: null,
        servedModel: null,
        requestedModel: null,
        usage: null,
        costUsd: null,
        stopReason: null,
        error: sessionError('api_error', message, at, count(error.status)),
      })
      errors += 1
      return
    }

    const message = isRecord(record.message) ? record.message : null
    if (message === null) {
      builder.gap(`record ${uuid}: ${type} record has no message`)
      return
    }

    if (type === 'user') {
      aborted = null
      const content = message.content
      if (typeof content === 'string') {
        if (INTERRUPTED.test(content)) aborted = { at }
        builder.message({
          id: uuid,
          role: 'user',
          actor: machine(content) ? 'injected' : subagent ? 'subagent-spawn' : 'human',
          at,
          modelCallId: null,
          parts: [{ type: 'text', text: machine(content) ? content : claudeTypedPromptText(content) }],
        })
        return
      }
      if (!Array.isArray(content)) return
      const toolParts: Part[] = []
      const userParts: Part[] = []
      for (const block of content) {
        if (!isRecord(block)) continue
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          toolParts.push({ type: 'tool-result', toolCallId: block.tool_use_id })
          const results = content.filter((b) => isRecord(b) && b.type === 'tool_result').length
          builder.toolResult(block.tool_use_id, {
            output: block.content ?? null,
            text: textOf(block.content),
            isError: block.is_error === true,
            at,
            messageId: `${uuid}:tool`,
            details: results === 1 ? (record.toolUseResult ?? null) : null,
          })
          const result = isRecord(record.toolUseResult) ? record.toolUseResult : null
          const agentId = result ? str(result.agentId) : null
          if (agentId) builder.child(agentId, block.tool_use_id)
        } else if (block.type === 'text' && typeof block.text === 'string') {
          if (INTERRUPTED.test(block.text)) aborted = { at }
          userParts.push({ type: 'text', text: claudeTypedPromptText(block.text) })
        } else if (block.type === 'image' || block.type === 'document') {
          const source = isRecord(block.source) ? block.source : {}
          userParts.push({ type: 'attachment', mediaType: str(source.media_type) ?? String(block.type), ref: str(source.url) ?? `inline:${uuid}` })
        }
      }
      if (toolParts.length > 0) builder.message({ id: `${uuid}:tool`, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: toolParts })
      if (userParts.length > 0) {
        builder.message({
          id: uuid,
          role: 'user',
          actor: machine(firstText(userParts)) ? 'injected' : subagent ? 'subagent-spawn' : 'human',
          at,
          modelCallId: null,
          parts: userParts,
        })
      }
      return
    }

    aborted = null
    const model = str(message.model)
    const content = Array.isArray(message.content) ? message.content : []
    if (record.isApiErrorMessage === true || model === '<synthetic>') {
      const text = textOf(content) ?? 'API error'
      const call = builder.modelCall({
        id: uuid,
        at,
        provider: null,
        servedModel: null,
        requestedModel: null,
        usage: null,
        costUsd: null,
        stopReason: str(message.stop_reason),
        error: sessionError(str(record.error) ?? 'api-error', text, at),
      })
      builder.message({ id: uuid, role: 'assistant', actor: 'injected', at, modelCallId: call.id, parts: [{ type: 'text', text }] })
      errors += 1
      return
    }
    const apiId = str(message.id) ?? uuid
    const parts: Part[] = []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text })
      else if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push({ type: 'reasoning', text: block.thinking, redacted: false })
      else if (block.type === 'redacted_thinking') parts.push({ type: 'reasoning', text: '', redacted: true })
      else if ((block.type === 'tool_use' || block.type === 'server_tool_use') && typeof block.id === 'string') {
        parts.push({ type: 'tool-call', toolCallId: block.id })
        builder.toolCall({ id: block.id, name: str(block.name) ?? 'unknown', input: block.input ?? null, inputText: null, at, messageId: apiId })
      } else if (typeof block.type === 'string' && block.type.endsWith('_tool_result') && typeof block.tool_use_id === 'string') {
        builder.toolResult(block.tool_use_id, { output: block.content ?? null, text: textOf(block.content), isError: false, at, messageId: apiId })
      }
    }
    const existing = builder.getModelCall(apiId)
    if (existing) {
      existing.usage = usageOf(message.usage) ?? existing.usage
      existing.stopReason = str(message.stop_reason) ?? existing.stopReason
      if (builder.hasMessage(apiId)) builder.appendParts(apiId, parts)
      return
    }
    builder.modelCall({
      id: apiId,
      at,
      provider: null,
      servedModel: model,
      requestedModel: null,
      usage: usageOf(message.usage),
      costUsd: null,
      stopReason: str(message.stop_reason),
      error: null,
    })
    builder.message({ id: apiId, role: 'assistant', actor: 'agent', at, modelCallId: apiId, parts })
  }

  const finish = (): SessionBuilder => {

    builder.source(stats)
    if (sidechainSkipped > 0) builder.gap(`${sidechainSkipped} sidechain records in the main transcript belong to subagents and were not read as this session`)
    if (errors > 0 && builder.modelCalls.every((c) => c.error)) builder.gap('every model call in the session failed')
    builder.inferEnding(aborted ? { at: aborted.at, error: null } : undefined)
    return builder
  }
  return { builder, observe, finish }
}

export async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions, source: RecordSource = fileRecords(ref.path, { strict: options.corruption === 'strict', signal: options.signal })): Promise<SessionBuilder> {
  return runFold(createFold(ref, mode, source.stats), source)
}

async function locate(home: string, opts: LocateOptions): Promise<SessionRef[]> {
  const root = join(home, STORE.root)
  const all = await walkFiles(root)
  const main = storeGlob(STORE.files[0], opts.nativeSessionId)
  const nested = storeGlob(STORE.files[1], opts.nativeSessionId)
  const subagentsBySession = new Map<string, string[]>()
  for (const rel of all) {
    if (!nested.test(rel)) continue
    const [project, id] = rel.split('/')
    const key = `${project}/${id}`
    subagentsBySession.set(key, [...(subagentsBySession.get(key) ?? []), join(root, rel)])
  }
  const sessions = await mapLimit(all.filter((rel) => main.test(rel)), LOCATE_READS, async (rel): Promise<SessionRef[]> => {
    const path = join(root, rel)
    const id = basename(rel, '.jsonl')
    const mtime = await mtimeMs(path)
    if (opts.sinceMs && mtime < opts.sinceMs) return []
    const head = await headRecord(path, (r) => typeof r.cwd === 'string')
    const cwd = head ? str(head.cwd) : null
    if (opts.cwd && (cwd === null || !withinPath(cwd, opts.cwd))) return []
    const subagents = subagentsBySession.get(`${rel.split('/')[0]}/${id}`) ?? []
    const refs: SessionRef[] = [{ harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path, ...subagents], home, cwd, mtimeMs: mtime, parentNativeSessionId: null }]
    for (const file of subagents) {
      const agentId = basename(file, '.jsonl').replace(/^agent-/u, '')
      refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: agentId, path: file, files: [file], home, cwd, mtimeMs: await mtimeMs(file), parentNativeSessionId: id })
    }
    return refs
  })
  return sessions.flat().sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const claudeCodeReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['claude', 'claude-code-acp', 'claudish'],
  formats: [FORMAT],
  stores: [STORE],
  globs: { session: STORE.files[0], children: STORE.files[1] },
  evidence: EVIDENCE[FORMAT],
  locate: (home, opts = {}) => locate(home, opts),
  async read(ref, opts = {}): Promise<HarnessSession> {
    return (await fold(ref, 'full', opts)).build()
  },
  async summarize(ref, opts = {}): Promise<SessionSummary> {
    return (await fold(ref, 'summary', opts)).summary()
  },
}

export function claudeCodeRefForFile(path: string, parentNativeSessionId: string | null = null): SessionRef {
  const name = basename(path, '.jsonl')
  return {
    harness: HARNESS,
    format: FORMAT,
    nativeSessionId: parentNativeSessionId === null ? name : name.replace(/^agent-/u, ''),
    path,
    files: [path],
    home: null,
    cwd: null,
    mtimeMs: 0,
    parentNativeSessionId,
  }
}
