/**
 * Claude Code: `~/.claude/projects/<cwd slug>/<session id>.jsonl`, one JSON record per line, and
 * each subagent's own transcript at `<session id>/subagents/agent-<agent id>.jsonl`.
 *
 * Claude Code writes one `assistant` record per content block of an API response, repeating the
 * response's `message.id`, `model` and `usage` on each; the blocks are one model call. It writes a
 * failed call as an `assistant` record with `isApiErrorMessage` and model `<synthetic>`, and each
 * retried API failure as a `system` record with subtype `api_error`. `message.model` is the model
 * the API answered with.
 */
import { basename, join } from 'node:path'
import { SessionBuilder, count, isRecord, sessionError, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSession, HarnessSessionReader, LocateOptions, Part, ReadOptions, SessionRef, SessionSummary, TokenUsage } from '../schema.js'
import { fileRecords, type RecordSource, type SourceStats } from '../source.js'
import { runFold, type SessionFold } from './fold.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { headRecord } from './head.js'

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

const INTERRUPTED = /^\[Request interrupted by user/u

export function createFold(ref: SessionRef, mode: BuildMode, stats: SourceStats): SessionFold {
  const subagent = ref.parentNativeSessionId !== null
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  let sidechainSkipped = 0
  let aborted: { at: string | null } | null = null
  let errors = 0
  let identified = false

  const observe = (record: Record<string, unknown>): void => {
    if (!subagent && record.isSidechain === true) {
      sidechainSkipped += 1
      return
    }
    const type = record.type
    if (type !== 'user' && type !== 'assistant' && type !== 'system') return
    const at = builder.seen(record.timestamp)
    if (builder.cwd === null && typeof record.cwd === 'string') builder.cwd = record.cwd
    if (!identified && typeof record.sessionId === 'string') {
      // The records name the session; a subagent's records name its parent and its agent id.
      identified = true
      if (subagent && typeof record.agentId === 'string') {
        builder.nativeSessionId = record.agentId
        builder.parentNativeSessionId = record.sessionId
      } else if (!subagent) {
        builder.nativeSessionId = record.sessionId
      }
    }
    const uuid = str(record.uuid) ?? `${builder.nativeSessionId}:${stats.line}`

    if (type === 'system') {
      if (record.subtype !== 'api_error') return
      // A failed API request that Claude Code retried (or gave up on). It is a model call that
      // returned no answer; a later success supersedes it in the ending.
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
          actor: record.isMeta === true || record.isCompactSummary === true ? 'injected' : subagent ? 'subagent-spawn' : 'human',
          at,
          modelCallId: null,
          parts: [{ type: 'text', text: content }],
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
            // The record's structured result belongs to its tool result when it carries one.
            details: results === 1 ? (record.toolUseResult ?? null) : null,
          })
          const result = isRecord(record.toolUseResult) ? record.toolUseResult : null
          const agentId = result ? str(result.agentId) : null
          if (agentId) builder.child(agentId, block.tool_use_id)
        } else if (block.type === 'text' && typeof block.text === 'string') {
          if (INTERRUPTED.test(block.text)) aborted = { at }
          userParts.push({ type: 'text', text: block.text })
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
          actor: record.isMeta === true ? 'injected' : subagent ? 'subagent-spawn' : 'human',
          at,
          modelCallId: null,
          parts: userParts,
        })
      }
      return
    }

    // assistant
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
      // A later block of the same response: its usage is the response's final usage so far.
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
  const refs: SessionRef[] = []
  for (const rel of all) {
    if (!main.test(rel)) continue
    const path = join(root, rel)
    const id = basename(rel, '.jsonl')
    const mtime = await mtimeMs(path)
    if (opts.sinceMs && mtime < opts.sinceMs) continue
    const head = await headRecord(path, (r) => typeof r.cwd === 'string')
    const cwd = head ? str(head.cwd) : null
    if (opts.cwd && (cwd === null || !cwd.startsWith(opts.cwd))) continue
    const subagents = subagentsBySession.get(`${rel.split('/')[0]}/${id}`) ?? []
    refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path, ...subagents], home, cwd, mtimeMs: mtime, parentNativeSessionId: null })
    for (const file of subagents) {
      const agentId = basename(file, '.jsonl').replace(/^agent-/u, '')
      refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: agentId, path: file, files: [file], home, cwd, mtimeMs: await mtimeMs(file), parentNativeSessionId: id })
    }
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const claudeCodeReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['claude', 'claude-code-acp', 'claudish'],
  formats: [FORMAT],
  stores: [STORE],
  evidence: EVIDENCE[FORMAT],
  locate: (home, opts = {}) => locate(home, opts),
  async read(ref, opts = {}): Promise<HarnessSession> {
    return (await fold(ref, 'full', opts)).build()
  },
  async summarize(ref, opts = {}): Promise<SessionSummary> {
    return (await fold(ref, 'summary', opts)).summary()
  },
}

/** A reader for one transcript file outside a HOME layout (the CLI, a retained copy). */
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
