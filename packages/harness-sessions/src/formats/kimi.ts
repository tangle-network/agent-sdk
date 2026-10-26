import { isRecord } from '@tangle-network/agent-core'
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
 * subagent's events arrive wrapped in `SubagentEvent`. The legacy wire records no model.
 * Current `.kimi-code/sessions/wd_<hash>/session_<uuid>/agents/main/wire.jsonl` records are flat:
 * turn prompts and loop events own messages, tools and step usage. Appended message snapshots,
 * usage records and token-counting totals mirror that work, so are not counted again. Request
 * metadata names the requested model; a completed native turn is required to prove completion.
 */
import { basename, dirname, join } from 'node:path'
import { SessionBuilder, count, sessionError, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, LocateOptions, ModelCall, Part, ReadOptions, SessionEnding, SessionRef, TokenUsage } from '../schema.js'
import { fileRecords, type RecordSource, type SourceStats } from '../source.js'
import { KIMI_STORES } from '../catalog.js'
import { EVIDENCE, mtimeMs, storeGlob, walkFiles, withinPath } from '../stores.js'
import { runFold, type SessionFold } from './fold.js'

const FORMAT = 'kimi.session-dir' as const
const HARNESS = 'kimi-code'
/** The event stream this reader folds; the store also holds context.jsonl and state.json. */
const WIRE = '*/{id}/wire.jsonl'
const CHILD_WIRE = '*/*/subagents/{id}/wire.jsonl'

/** Current main agents belong to session_<uuid>; legacy child wires retain their own agent IDs. */
function sessionIdentity(path: string): { id: string; parent: string | null } {
  const directory = dirname(path)
  const container = dirname(directory)
  if (basename(container) === 'agents' && basename(directory) === 'main') return { id: basename(dirname(container)), parent: null }
  return { id: basename(directory), parent: basename(container) === 'subagents' ? basename(dirname(container)) : null }
}

function usageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  return usageOrNull({
    input: count(value.input_other ?? value.inputOther),
    output: count(value.output),
    reasoning: null,
    cacheRead: count(value.input_cache_read ?? value.inputCacheRead),
    cacheWrite: count(value.input_cache_creation ?? value.inputCacheCreation),
  })
}

export function createFold(ref: SessionRef, mode: BuildMode, stats: SourceStats): SessionFold {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  let turn = 0
  let step: { call: ModelCall; messageId: string } | null = null
  let lastToolCall: { id: string; text: string } | null = null
  let aborted: { at: string | null } | null = null
  let compactions = 0
  let subagentEvents = 0
  let flat = false
  let promptId: string | null = null
  let nativeEnding: SessionEnding = { status: 'open', error: null, at: null }
  let nativeReason: string | null = null

  const openStep = (at: string | null): { call: ModelCall; messageId: string } => {
    if (step) return step
    const id = `${builder.nativeSessionId}:turn:${turn}:step:${builder.modelCalls.length + 1}`
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
    const message = isRecord(record.message) ? record.message : {}
    const outer = str(record.type)
    // Both protocols have metadata; only flat payload events use namespaced discriminators.
    flat ||= outer?.includes('.') === true
    const payload = outer === 'context.append_loop_event' && isRecord(record.event) ? record.event : outer ? record : isRecord(message.payload) ? message.payload : {}
    const type = outer === 'context.append_loop_event' ? str(payload.type) : outer ?? str(message.type)
    const at = builder.seen(record.time ?? record.timestamp ?? record.created_at)
    if (type !== 'ToolCallPart') flushToolArguments()
    switch (type) {
      case 'profile.bind':
        if (isRecord(payload.environmentDisclosure)) builder.cwd = str(payload.environmentDisclosure.cwd)
        break
      case 'turn.prompt':
      case 'TurnBegin': {
        turn += 1
        step = null
        aborted = null
        promptId = str(payload.promptId)
        nativeEnding = { status: 'open', error: null, at: null }
        nativeReason = null
        const text = textOf(payload.user_input ?? payload.input)
        const parts: Part[] = text === null ? [] : [{ type: 'text', text }]
        builder.message({ id: `${builder.nativeSessionId}:turn:${turn}:input`, role: 'user', actor: ref.parentNativeSessionId ? 'subagent-spawn' : 'human', at, modelCallId: null, parts })
        break
      }
      case 'context.append_message': {
        const value = isRecord(payload.message) ? payload.message : {}
        if (value.role !== 'user' || (promptId !== null && value.id === promptId)) break
        const origin = isRecord(value.origin) ? value.origin : {}
        const text = textOf(value.content)
        builder.message({ id: str(value.id) ?? `${builder.nativeSessionId}:context:${stats.line}`, role: 'user', actor: origin.kind === 'user' ? 'human' : 'injected', at, modelCallId: null, parts: text === null ? [] : [{ type: 'text', text }] })
        break
      }
      case 'llm.request': {
        const current = openStep(at)
        current.call.requestedModel = str(payload.model)
        current.call.provider = str(payload.provider)
        break
      }
      case 'step.begin':
      case 'StepBegin':
        step = null
        openStep(at)
        break
      case 'content.part':
      case 'ContentPart': {
        const current = openStep(at)
        const part = isRecord(payload.part) ? payload.part : payload
        if (part.type === 'think') builder.appendParts(current.messageId, [{ type: 'reasoning', text: str(part.think) ?? '', redacted: part.encrypted != null && !part.think }])
        else if (typeof part.text === 'string') builder.appendParts(current.messageId, [{ type: 'text', text: part.text }])
        break
      }
      case 'tool.call':
      case 'ToolCall': {
        const current = openStep(at)
        const fn = isRecord(payload.function) ? payload.function : { name: payload.name, arguments: payload.args }
        const id = str(payload.id) ?? str(payload.toolCallId) ?? `${builder.nativeSessionId}:call:${stats.line}`
        const text = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
        builder.appendParts(current.messageId, [{ type: 'tool-call', toolCallId: id }])
        builder.toolCall({ id, name: str(fn.name) ?? 'unknown', input: null, inputText: text, at, messageId: current.messageId })
        lastToolCall = { id, text }
        break
      }
      case 'ToolCallPart':
        if (lastToolCall && typeof payload.arguments_part === 'string') lastToolCall.text += payload.arguments_part
        break
      case 'tool.result':
      case 'ToolResult': {
        const id = str(payload.tool_call_id) ?? str(payload.toolCallId) ?? ''
        const value = isRecord(payload.return_value) ? payload.return_value : isRecord(payload.result) ? payload.result : {}
        const resultId = `${id}:result`
        builder.message({ id: resultId, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: id }] })
        builder.toolResult(id, { output: value.output ?? null, text: typeof value.output === 'string' ? value.output : textOf(value.output), isError: value.is_error === true, at, messageId: resultId, details: value })
        break
      }
      case 'step.end':
      case 'StatusUpdate': {
        const usage = usageOf(payload.token_usage ?? payload.usage)
        if (usage === null) break
        const current = openStep(at)
        current.call.usage = usage
        if (type === 'step.end') current.call.stopReason = str(payload.finishReason)
        break
      }
      case 'StepRetry': {
        // A failed attempt Kimi retried: a model call that returned no answer.
        builder.modelCall({
          id: `${builder.nativeSessionId}:turn:${turn}:retry:${builder.modelCalls.length + 1}`, at, provider: null, servedModel: null, requestedModel: null, usage: null, costUsd: null, stopReason: null,
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
      case 'turn.ended':
      case 'prompt.completed':
      case 'prompt.aborted': {
        const reason = type === 'prompt.aborted' ? 'cancelled' : str(payload.reason)
        const status = reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'aborted' : reason === 'failed' || reason === 'blocked' ? 'error' : 'open'
        const endedAt = builder.seen(payload.abortedAt ?? payload.finishedAt) ?? at
        const error = isRecord(payload.error) && typeof payload.error.code === 'string' && typeof payload.error.message === 'string' ? { kind: payload.error.code, message: payload.error.message, httpStatus: null, at: endedAt } : reason === nativeReason ? nativeEnding.error : null
        nativeEnding = { status, error, at: status === 'open' ? null : endedAt }
        nativeReason = reason
        if (status === 'open') builder.gap('Native ending reason is unknown')
        break
      }
      case 'CompactionBegin':
        compactions += 1
        break
      case 'SubagentEvent': {
        subagentEvents += 1
        const agent = str(payload.agent_id)
        if (agent) builder.child(agent, str(payload.parent_tool_call_id) ?? str(payload.task_tool_call_id))
        break
      }
      default:
        break
    }
  }

  const finish = (): SessionBuilder => {
    flushToolArguments()
    builder.source(stats)
    if (ref.truncated) builder.markTruncated(`${ref.path}: the session copy was cut short`)
    if (compactions > 0) builder.gap(`${compactions} compactions replaced earlier context`)
    if (subagentEvents > 0) builder.gap(`${subagentEvents} wrapped subagent events were excluded from this session's own messages and usage; separate child wires must be read for child execution`)
    if (flat) builder.end(nativeEnding)
    else builder.inferEnding(aborted ? { at: (aborted as { at: string | null }).at, error: null } : undefined)
    return builder
  }
  return { builder, observe, finish }
}

export async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions, source: RecordSource = fileRecords(ref.path, { strict: options.corruption === 'strict', signal: options.signal })): Promise<SessionBuilder> {
  return runFold(createFold(ref, mode, source.stats), source)
}

async function locate(home: string, opts: LocateOptions): Promise<SessionRef[]> {
  const refs: SessionRef[] = []
  for (const store of KIMI_STORES) {
    const root = join(home, store.root)
    const pattern = storeGlob('globs' in store ? store.globs.session : WIRE)
    const children = storeGlob(CHILD_WIRE)
    const matches = (rel: string): boolean => {
      const { id, parent } = sessionIdentity(rel)
      return (pattern.test(rel) || children.test(rel)) && (!opts.nativeSessionId || id === opts.nativeSessionId || parent === opts.nativeSessionId)
    }
    for (const rel of await walkFiles(root, undefined, matches)) {
      const path = join(root, rel)
      const mtime = await mtimeMs(path)
      if (opts.sinceMs && mtime < opts.sinceMs) continue
      const context = join(dirname(path), 'context.jsonl')
      const files = (await mtimeMs(context)) > 0 ? [path, context] : [path]
      const ref: SessionRef = { ...kimiRefForFile(path), files, home, mtimeMs: mtime }
      if (opts.cwd) {
        ref.cwd = (await fold(ref, 'summary', {})).cwd
        if (ref.cwd === null || !withinPath(ref.cwd, opts.cwd)) continue
      }
      refs.push(ref)
    }
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const kimiReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['kimi', 'kimi-cli'],
  formats: [FORMAT],
  stores: KIMI_STORES,
  globs: { session: WIRE, children: CHILD_WIRE },
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
  const { id, parent } = sessionIdentity(path)
  return { harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: parent }
}
