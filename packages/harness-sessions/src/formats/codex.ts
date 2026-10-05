/**
 * Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`, one
 * `{timestamp, type, payload}` record per line.
 *
 * `response_item` records are the conversation (messages, reasoning, tool calls and their
 * outputs); `event_msg` records are the harness's events (`token_count` after each model response,
 * `error`, `stream_error`, `turn_aborted`, `task_complete`). Codex records the model it was
 * configured with in `turn_context`, not the model the provider answered with, so the served
 * model here has source `turn-context`. Usage is per response (`last_token_usage`) and cumulative
 * (`total_token_usage`); the cumulative counter is the session total.
 */
import { basename } from 'node:path'
import {
  SessionBuilder,
  argumentsOf,
  count,
  isRecord,
  sessionError,
  str,
  textOf,
  usageOrNull,
  type BuildMode,
} from '../builder.js'
import type { HarnessSessionReader, LocateOptions, ModelCall, Part, ReadOptions, SessionRef, TokenUsage } from '../schema.js'
import { fileRecords, type RecordSource, type SourceStats } from '../source.js'
import { runFold, type SessionFold } from './fold.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { headRecord } from './head.js'
import { join } from 'node:path'

const FORMAT = 'codex.rollout-jsonl' as const
const STORE = STORES[FORMAT]
const HARNESS = 'codex'
const ID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u

/** Codex counts cached tokens inside `input_tokens`; the normalized input excludes them. */
function usageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const input = count(value.input_tokens)
  const cached = count(value.cached_input_tokens)
  return usageOrNull({
    input: input === null ? null : Math.max(0, input - (cached ?? 0)),
    output: count(value.output_tokens),
    reasoning: count(value.reasoning_output_tokens),
    cacheRead: cached,
    cacheWrite: count(value.cache_write_input_tokens),
  })
}

function signature(value: unknown): string {
  return isRecord(value)
    ? ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].map((k) => String(value[k] ?? '')).join(',')
    : ''
}

function addTotals(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null) return b
  if (b === null) return a
  const sum = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) + (y ?? 0))
  return { input: sum(a.input, b.input), output: sum(a.output, b.output), reasoning: sum(a.reasoning, b.reasoning), cacheRead: sum(a.cacheRead, b.cacheRead), cacheWrite: sum(a.cacheWrite, b.cacheWrite) }
}

// Text the harness puts in a user-role message: environment context, instructions, shell output.
const INJECTED_USER_TEXT = /^\s*(?:<[a-z_]+(?:\s[^>]*)?>|# AGENTS\.md instructions)/u

function contentParts(content: unknown): Part[] {
  const parts: Part[] = []
  if (!Array.isArray(content)) return parts
  for (const item of content) {
    if (!isRecord(item)) continue
    if ((item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text })
    } else if (item.type === 'input_image') {
      parts.push({ type: 'attachment', mediaType: 'image', ref: typeof item.image_url === 'string' && !item.image_url.startsWith('data:') ? item.image_url : 'inline' })
    }
  }
  return parts
}

function outputOf(output: unknown): { output: unknown; text: string | null; isError: boolean } {
  if (typeof output === 'string') return { output, text: output, isError: false }
  if (isRecord(output)) {
    const content = output.content ?? output.output
    return { output, text: textOf(content) ?? (typeof content === 'string' ? content : null), isError: output.success === false }
  }
  return { output: output ?? null, text: textOf(output), isError: false }
}

const MODEL_OUTPUT = new Set(['message', 'reasoning'])

export function createFold(ref: SessionRef, mode: BuildMode, stats: SourceStats): SessionFold {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  let provider: string | null = null
  let model: string | null = null
  let open: ModelCall | null = null
  let openMessage: string | null = null
  let calls = 0
  let lastTotalSignature = ''
  let lastTotal: TokenUsage | null = null
  let lastTotalRaw: Record<string, unknown> | null = null
  let committedTotal: TokenUsage | null = null
  let aborted: { at: string | null; reason: string } | null = null
  let sawMeta = false
  let compacted = 0
  // A forked rollout replays the parent's history after the parent's own session_meta; that
  // history is copied context, not this session's turns. It ends at this session's first turn,
  // whose (time-ordered, UUIDv7) turn id sorts at or after the session id.
  let forked = false
  let inherited = false
  let inheritedRecords = 0
  const foreignThreads = new Set<string>()

  const openCall = (at: string | null): ModelCall => {
    if (open) return open
    calls += 1
    open = builder.modelCall({ id: `${builder.nativeSessionId}:response:${calls}`, at, provider, servedModel: model, requestedModel: model, usage: null, costUsd: null, stopReason: null, error: null })
    openMessage = null
    return open
  }
  const assistantMessage = (at: string | null, call: ModelCall, parts: Part[]): void => {
    if (openMessage === null) {
      openMessage = `${call.id}:message`
      builder.message({ id: openMessage, role: 'assistant', actor: 'agent', at, modelCallId: call.id, parts })
    } else {
      builder.appendParts(openMessage, parts)
    }
  }

  const observe = (record: Record<string, unknown>): void => {
    const payload = isRecord(record.payload) ? record.payload : {}
    if (inherited) {
      const turnId = str(payload.turn_id)
      if (record.type === 'event_msg' && payload.type === 'task_started' && turnId !== null && turnId >= builder.nativeSessionId) {
        inherited = false
      } else {
        inheritedRecords += 1
        if (record.type === 'response_item' && payload.type === 'message') {
          const role = str(payload.role)
          builder.message({ id: str(payload.id) ?? `${builder.nativeSessionId}:inherited:${inheritedRecords}`, role: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'system', actor: 'injected', at: null, modelCallId: null, parts: contentParts(payload.content) })
        }
        return
      }
    }
    const at = builder.seen(record.timestamp)
    switch (record.type) {
      case 'session_meta': {
        if (sawMeta) {
          if (forked) inherited = true
          break
        }
        sawMeta = true
        const id = str(payload.id)
        if (id && id !== builder.nativeSessionId) builder.nativeSessionId = id
        builder.cwd = str(payload.cwd)
        provider = str(payload.model_provider)
        forked = typeof payload.forked_from_id === 'string'
        const source = isRecord(payload.source) ? payload.source : {}
        const spawn = isRecord(source.subagent) && isRecord(source.subagent.thread_spawn) ? source.subagent.thread_spawn : {}
        const parent = str(payload.parent_thread_id) ?? str(spawn.parent_thread_id) ?? str(payload.forked_from_id)
        if (parent) builder.parentNativeSessionId = parent
        break
      }
      case 'turn_context': {
        model = str(payload.model) ?? model
        break
      }
      case 'compacted': {
        compacted += 1
        break
      }
      case 'response_item': {
        const kind = str(payload.type) ?? ''
        if (kind === 'agent_message') {
          // A message from another agent of the same run (a task or a reply); input to this thread.
          open = null
          builder.message({ id: str(payload.id) ?? `${builder.nativeSessionId}:${stats.line}`, role: 'user', actor: 'subagent-spawn', at, modelCallId: null, parts: contentParts(payload.content) })
        } else if (kind === 'message') {
          const role = str(payload.role)
          const parts = contentParts(payload.content)
          if (role === 'assistant') {
            assistantMessage(at, openCall(at), parts)
          } else if (role === 'user') {
            open = null
            const text = parts.find((p) => p.type === 'text')
            const injected = text?.type === 'text' && INJECTED_USER_TEXT.test(text.text)
            builder.message({ id: str(payload.id) ?? `${builder.nativeSessionId}:${stats.line}`, role: 'user', actor: injected ? 'injected' : ref.parentNativeSessionId || builder.parentNativeSessionId ? 'subagent-spawn' : 'human', at, modelCallId: null, parts })
          } else {
            builder.message({ id: str(payload.id) ?? `${builder.nativeSessionId}:${stats.line}`, role: 'system', actor: 'injected', at, modelCallId: null, parts })
          }
        } else if (kind === 'reasoning') {
          const summary = Array.isArray(payload.summary) ? payload.summary : []
          const text = summary.map((s) => (isRecord(s) && typeof s.text === 'string' ? s.text : '')).filter(Boolean).join('\n')
          const content = textOf(payload.content)
          const visible = content ?? text
          assistantMessage(at, openCall(at), [{ type: 'reasoning', text: visible, redacted: visible.length === 0 && payload.encrypted_content != null }])
        } else if (kind.endsWith('_call') && !MODEL_OUTPUT.has(kind)) {
          const callId = str(payload.call_id) ?? str(payload.id) ?? `${builder.nativeSessionId}:call:${stats.line}`
          const name = str(payload.name) ?? kind.replace(/_call$/u, '')
          const raw = kind === 'function_call' ? payload.arguments : kind === 'custom_tool_call' ? payload.input : (payload.action ?? payload.arguments ?? payload.input)
          const call = openCall(at)
          assistantMessage(at, call, [{ type: 'tool-call', toolCallId: callId }])
          builder.toolCall({ id: callId, name, ...argumentsOf(raw), at, messageId: openMessage! })
          // A web search is answered inside the response; there is no output item.
          if (kind === 'web_search_call') builder.toolResult(callId, { output: payload.action ?? null, text: null, isError: payload.status === 'failed', at, messageId: openMessage! })
        } else if (kind.endsWith('_call_output')) {
          const callId = str(payload.call_id) ?? ''
          const result = outputOf(payload.output)
          const id = `${callId}:output`
          builder.message({ id, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: callId }] })
          builder.toolResult(callId, { ...result, at, messageId: id })
        }
        break
      }
      case 'event_msg': {
        const kind = str(payload.type)
        if (kind === 'item_completed') {
          // Items of this thread repeat its response items. Items of another thread are a child
          // thread's activity (a review or a sub-agent) logged in this rollout; that thread is its
          // own session.
          const thread = str(payload.thread_id)
          if (thread && thread !== builder.nativeSessionId && !foreignThreads.has(thread)) {
            foreignThreads.add(thread)
            builder.child(thread, null)
          }
        } else if (kind === 'token_count') {
          const info = isRecord(payload.info) ? payload.info : null
          if (info === null) break
          const totalSignature = signature(info.total_token_usage)
          // Codex repeats a token_count without a new response (rate-limit refreshes); a
          // response is counted once, when the cumulative counter moves.
          if (totalSignature !== '' && totalSignature === lastTotalSignature) break
          if (isRecord(info.total_token_usage)) {
            const raw = info.total_token_usage
            // A resumed process restarts the counter; bank what the previous process reported.
            if (lastTotalRaw && count(raw.total_tokens) !== null && count(lastTotalRaw.total_tokens) !== null && (raw.total_tokens as number) < (lastTotalRaw.total_tokens as number)) {
              committedTotal = addTotals(committedTotal, lastTotal)
            }
            lastTotalRaw = raw
            lastTotal = usageOf(raw)
            lastTotalSignature = totalSignature
          }
          const usage = usageOf(info.last_token_usage)
          if (usage === null) break
          const call = openCall(at)
          call.usage = usage
          open = null
        } else if (kind === 'error') {
          const message = str(payload.message) ?? 'error'
          const call = openCall(at)
          call.error = sessionError('error', message, at, httpStatusOf(payload))
          open = null
        } else if (kind === 'stream_error') {
          // A dropped stream that Codex retries. It is a model request that returned no answer.
          calls += 1
          builder.modelCall({ id: `${builder.nativeSessionId}:response:${calls}`, at, provider, servedModel: model, requestedModel: model, usage: null, costUsd: null, stopReason: null, error: sessionError('stream_error', str(payload.message) ?? 'stream error', at, httpStatusOf(payload)) })
        } else if (kind === 'turn_aborted') {
          aborted = { at, reason: str(payload.reason) ?? 'aborted' }
          open = null
        } else if (kind === 'task_started') {
          aborted = null
          open = null
        } else if (kind === 'task_complete') {
          aborted = null
          open = null
        }
        break
      }
      default:
        break
    }
  }

  const finish = (): SessionBuilder => {

    builder.source(stats)
    if (compacted > 0) builder.gap(`${compacted} compaction records replaced earlier context`)
    if (inheritedRecords > 0) builder.gap(`${inheritedRecords} records replay the history of the session this one was forked from`)
    if (foreignThreads.size > 0) builder.gap(`${foreignThreads.size} child threads logged their items in this rollout; they are not read as this session`)
    const total = addTotals(committedTotal, lastTotal)
    if (total !== null) builder.setSessionUsage(total)
    const last = builder.modelCalls[builder.modelCalls.length - 1]
    builder.inferEnding(aborted && !last?.error ? { at: aborted.at, error: sessionError('turn_aborted', aborted.reason, aborted.at, null) } : undefined)
    return builder
  }
  return { builder, observe, finish }
}

export async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions, source: RecordSource = fileRecords(ref.path, { strict: options.corruption === 'strict', signal: options.signal })): Promise<SessionBuilder> {
  return runFold(createFold(ref, mode, source.stats), source)
}

function httpStatusOf(payload: Record<string, unknown>): number | null {
  const info = payload.codex_error_info
  if (isRecord(info)) {
    for (const value of Object.values(info)) {
      if (isRecord(value)) {
        const status = count(value.http_status_code)
        if (status !== null) return status
      }
    }
  }
  return null
}

async function locate(home: string, opts: LocateOptions): Promise<SessionRef[]> {
  const root = join(home, STORE.root)
  const pattern = storeGlob(STORE.files[0], opts.nativeSessionId)
  const refs: SessionRef[] = []
  for (const rel of await walkFiles(root)) {
    if (!pattern.test(rel)) continue
    const path = join(root, rel)
    const mtime = await mtimeMs(path)
    if (opts.sinceMs && mtime < opts.sinceMs) continue
    const meta = await headRecord(path, (r) => r.type === 'session_meta', 4)
    const payload = meta && isRecord(meta.payload) ? meta.payload : {}
    const cwd = str(payload.cwd)
    if (opts.cwd && (cwd === null || !cwd.startsWith(opts.cwd))) continue
    const id = str(payload.id) ?? ID_IN_NAME.exec(rel)?.[1] ?? basename(rel, '.jsonl')
    const source = isRecord(payload.source) ? payload.source : {}
    const spawn = isRecord(source.subagent) && isRecord(source.subagent.thread_spawn) ? source.subagent.thread_spawn : {}
    refs.push({
      harness: HARNESS,
      format: FORMAT,
      nativeSessionId: id,
      path,
      files: [path],
      home,
      cwd,
      mtimeMs: mtime,
      parentNativeSessionId: str(payload.parent_thread_id) ?? str(spawn.parent_thread_id),
    })
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const codexReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['codex-acp', 'codex-cli'],
  formats: [FORMAT],
  stores: [STORE],
  evidence: EVIDENCE[FORMAT],
  locate: (home, opts = {}) => locate(home, opts),
  async read(ref, opts = {}) {
    return (await fold(ref, 'full', opts)).build()
  },
  async summarize(ref, opts = {}) {
    return (await fold(ref, 'summary', opts)).summary()
  },
}

export function codexRefForFile(path: string): SessionRef {
  return {
    harness: HARNESS,
    format: FORMAT,
    nativeSessionId: ID_IN_NAME.exec(path)?.[1] ?? basename(path, '.jsonl'),
    path,
    files: [path],
    home: null,
    cwd: null,
    mtimeMs: 0,
    parentNativeSessionId: null,
  }
}
