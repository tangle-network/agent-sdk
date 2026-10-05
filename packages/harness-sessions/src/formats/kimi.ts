/**
 * Kimi Code: one directory per session, `~/.kimi/sessions/<workdir hash>/<session id>/`, holding
 * `wire.jsonl` (the event stream this reader folds) and `context.jsonl` (the model context).
 *
 * Wire records are `{timestamp, message: {type, payload}}` with epoch-second timestamps.
 * `TurnBegin` carries the user's input; each `StepBegin` is one model call, whose `ContentPart`s
 * (`think`, `text`), `ToolCall`s (arguments streamed on in `ToolCallPart`s) and `StatusUpdate`
 * (`token_usage`: `input_other`, `output`, `input_cache_read`, `input_cache_creation`, disjoint,
 * and the provider's `message_id`) follow. `ToolResult` answers a call. `StepRetry` is a failed
 * attempt with the provider's status code; `StepInterrupted` ends a step without an answer. A
 * subagent's events arrive wrapped in `SubagentEvent`. The wire records no model.
 */
import { basename, dirname, join } from 'node:path'
import { SessionBuilder, count, isRecord, sessionError, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, LocateOptions, ModelCall, Part, ReadOptions, SessionRef, TokenUsage } from '../schema.js'
import { fileRecords, type RecordSource, type SourceStats } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { runFold, type SessionFold } from './fold.js'

const FORMAT = 'kimi.session-dir' as const
const STORE = STORES[FORMAT]
const HARNESS = 'kimi-code'

function usageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  return usageOrNull({
    input: count(value.input_other),
    output: count(value.output),
    reasoning: null,
    cacheRead: count(value.input_cache_read),
    cacheWrite: count(value.input_cache_creation),
  })
}

export function createFold(ref: SessionRef, mode: BuildMode, stats: SourceStats): SessionFold {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  let turn = 0
  let calls = 0
  let step: { call: ModelCall; messageId: string } | null = null
  let lastToolCall: { id: string; text: string } | null = null
  let aborted: { at: string | null } | null = null
  let compactions = 0
  let subagentEvents = 0

  const openStep = (at: string | null): { call: ModelCall; messageId: string } => {
    if (step) return step
    calls += 1
    const id = `${builder.nativeSessionId}:turn:${turn}:step:${calls}`
    const call = builder.modelCall({ id, at, provider: null, servedModel: null, requestedModel: null, usage: null, costUsd: null, stopReason: null, error: null })
    builder.message({ id: `${id}:message`, role: 'assistant', actor: 'agent', at, modelCallId: id, parts: [] })
    step = { call, messageId: `${id}:message` }
    return step
  }
  const flushToolArguments = (): void => {
    if (lastToolCall) builder.setToolInput(lastToolCall.id, lastToolCall.text)
    lastToolCall = null
  }

  const observe = (record: Record<string, unknown>): void => {
    const message = isRecord(record.message) ? record.message : null
    if (message === null) return
    const type = str(message.type)
    const payload = isRecord(message.payload) ? message.payload : {}
    const at = builder.seen(record.timestamp)
    if (type !== 'ToolCallPart') flushToolArguments()
    switch (type) {
      case 'TurnBegin': {
        turn += 1
        step = null
        aborted = null
        const input = payload.user_input
        const parts: Part[] = typeof input === 'string'
          ? [{ type: 'text', text: input }]
          : (textOf(input) !== null ? [{ type: 'text', text: textOf(input)! }] : [])
        builder.message({ id: `${builder.nativeSessionId}:turn:${turn}:input`, role: 'user', actor: ref.parentNativeSessionId ? 'subagent-spawn' : 'human', at, modelCallId: null, parts })
        break
      }
      case 'StepBegin':
        step = null
        openStep(at)
        break
      case 'ContentPart': {
        const current = openStep(at)
        if (payload.type === 'think') builder.appendParts(current.messageId, [{ type: 'reasoning', text: str(payload.think) ?? '', redacted: payload.encrypted != null && !payload.think }])
        else if (typeof payload.text === 'string') builder.appendParts(current.messageId, [{ type: 'text', text: payload.text }])
        break
      }
      case 'ToolCall': {
        const current = openStep(at)
        const fn = isRecord(payload.function) ? payload.function : {}
        const id = str(payload.id) ?? `${builder.nativeSessionId}:call:${stats.line}`
        const text = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
        builder.appendParts(current.messageId, [{ type: 'tool-call', toolCallId: id }])
        builder.toolCall({ id, name: str(fn.name) ?? 'unknown', input: null, inputText: text, at, messageId: current.messageId })
        lastToolCall = { id, text }
        break
      }
      case 'ToolCallPart':
        if (lastToolCall && typeof payload.arguments_part === 'string') lastToolCall.text += payload.arguments_part
        break
      case 'ToolResult': {
        const id = str(payload.tool_call_id) ?? ''
        const value = isRecord(payload.return_value) ? payload.return_value : {}
        const resultId = `${id}:result`
        builder.message({ id: resultId, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: id }] })
        builder.toolResult(id, { output: value.output ?? null, text: typeof value.output === 'string' ? value.output : textOf(value.output), isError: value.is_error === true, at, messageId: resultId, details: value })
        break
      }
      case 'StatusUpdate': {
        const usage = usageOf(payload.token_usage)
        if (usage === null) break
        const current = openStep(at)
        current.call.usage = usage
        break
      }
      case 'StepRetry': {
        // A failed attempt Kimi retried: a model call that returned no answer.
        calls += 1
        builder.modelCall({
          id: `${builder.nativeSessionId}:turn:${turn}:retry:${calls}`, at, provider: null, servedModel: null, requestedModel: null, usage: null, costUsd: null, stopReason: null,
          error: sessionError(str(payload.error_type) ?? 'retry', `${str(payload.error_type) ?? 'error'}${payload.status_code ? ` (status ${String(payload.status_code)})` : ''}`, at, count(payload.status_code)),
        })
        break
      }
      case 'StepInterrupted':
        aborted = { at }
        step = null
        break
      case 'TurnEnd':
        step = null
        break
      case 'CompactionBegin':
        compactions += 1
        break
      case 'SubagentEvent': {
        subagentEvents += 1
        const agent = str(payload.agent_id)
        if (agent) builder.child(agent, str(payload.parent_tool_call_id))
        break
      }
      default:
        break
    }
  }

  const finish = (): SessionBuilder => {
    flushToolArguments()
    builder.source(stats)
    if (compactions > 0) builder.gap(`${compactions} compactions replaced earlier context`)
    if (subagentEvents > 0) builder.gap(`${subagentEvents} subagent events are logged in this session; each subagent is its own session`)
    builder.inferEnding(aborted ? { at: (aborted as { at: string | null }).at, error: null } : undefined)
    return builder
  }
  return { builder, observe, finish }
}

export async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions, source: RecordSource = fileRecords(ref.path, { strict: options.corruption === 'strict', signal: options.signal })): Promise<SessionBuilder> {
  return runFold(createFold(ref, mode, source.stats), source)
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
    // Kimi keys the session directory by a hash of its working directory and records no cwd.
    if (opts.cwd) continue
    const id = basename(dirname(path))
    const context = join(dirname(path), 'context.jsonl')
    const files = (await mtimeMs(context)) > 0 ? [path, context] : [path]
    refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files, home, cwd: null, mtimeMs: mtime, parentNativeSessionId: null })
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const kimiReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['kimi', 'kimi-cli'],
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

/** A session read from its `wire.jsonl` outside a HOME layout. */
export function kimiRefForFile(path: string): SessionRef {
  return { harness: HARNESS, format: FORMAT, nativeSessionId: basename(dirname(path)), path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null }
}
