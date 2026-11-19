import { isRecord } from '@tangle-network/agent-core'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { SessionBuilder, count, sessionError, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, LocateOptions, ModelCall, Part, ReadOptions, SessionEnding, SessionRef, TokenUsage } from '../schema.js'
import { fileRecords, isMissing, type RecordSource, type SourceStats } from '../source.js'
import { KIMI_STORES } from '../catalog.js'
import { EVIDENCE, mtimeMs, storeGlob, walkFiles, withinPath } from '../stores.js'
import { foldedReader, runFold, type SessionFold } from './fold.js'

const FORMAT = 'kimi.session-dir' as const
const HARNESS = 'kimi-code'
const WIRE = '*/{id}/wire.jsonl'
const CHILD_WIRE = '*/{id}/subagents/*/wire.jsonl'

function scopedAgent(root: string, agent: string): string {
  return agent === 'main' ? root : `${root}/${agent}`
}

function sessionIdentity(path: string): { id: string; parent: string | null; root: string | null } {
  const directory = dirname(path)
  const container = dirname(directory)
  const agent = basename(directory)
  if (basename(container) === 'agents') {
    const root = basename(dirname(container))
    return { id: scopedAgent(root, agent), parent: null, root }
  }
  return { id: agent, parent: basename(container) === 'subagents' ? basename(dirname(container)) : null, root: null }
}

/** In 2.x every agent has a sibling directory. The small native index names its actual parent. */
function stateParents(path: string): Map<string, string> {
  let state: unknown
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return new Map()
    throw error
  }
  const parents = new Map<string, string>()
  if (isRecord(state) && typeof state.id === 'string' && isRecord(state.agents)) {
    for (const [agent, row] of Object.entries(state.agents)) {
      if (isRecord(row) && typeof row.parentAgentId === 'string')
        parents.set(scopedAgent(state.id, agent), scopedAgent(state.id, row.parentAgentId))
    }
  }
  return parents
}

function spawnEdge(ref: SessionRef, payload: Record<string, unknown>): { id: string; tool: string | null } | null {
  const [root, agent = 'main'] = ref.nativeSessionId.split('/')
  const child = str(payload.subagentId)
  if (!root || !child || child === 'main' || payload.parentAgentId !== agent || payload.callerAgentId !== agent) return null
  return { id: scopedAgent(root, child), tool: str(payload.parentToolCallId) }
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
      case 'subagent.spawned': {
        const child = spawnEdge(ref, payload)
        if (child) builder.child(child.id, child.tool)
        break
      }
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
  const { root } = sessionIdentity(ref.path)
  if (ref.parentNativeSessionId === null && root && ref.nativeSessionId !== root) {
    // A direct file read may have only the retained wires, without the session index.
    const agents = dirname(dirname(ref.path))
    ref = { ...ref }
    const family = [ref]
    for (const entry of await readdir(agents, { withFileTypes: true })) {
      const path = join(agents, entry.name, 'wire.jsonl')
      if (entry.isDirectory() && path !== ref.path && await mtimeMs(path)) family.push(refForWire(path, path))
    }
    await linkKimiFamily(family, undefined, options)
  }
  return runFold(createFold(ref, mode, source.stats), source)
}

/** Recover the originating call's owner only for a requested family missing its native index. */
export async function linkKimiFamily(refs: SessionRef[], statePath?: string, options: ReadOptions = {}): Promise<void> {
  const indexed = statePath ? stateParents(statePath) : new Map<string, string>()
  const missing = new Map<string, SessionRef>()
  for (const ref of refs) {
    ref.parentNativeSessionId ??= indexed.get(ref.nativeSessionId) ?? null
    if (ref.parentNativeSessionId === null && ref.nativeSessionId.includes('/')) missing.set(ref.nativeSessionId, ref)
  }
  if (!missing.size) return

  // A root normally records the first spawn long before it finishes. Stop at that record.
  const parents = [...refs].sort((a, b) => Number(a.nativeSessionId.includes('/')) - Number(b.nativeSessionId.includes('/')))
  for (const parent of parents) {
    if (missing.size === 1 && missing.has(parent.nativeSessionId)) continue
    for await (const row of fileRecords(parent.path, { signal: options.signal, strict: options.corruption === 'strict' }).records) {
      if (row.type !== 'subagent.spawned') continue
      const edge = spawnEdge(parent, row)
      const child = edge && missing.get(edge.id)
      if (child) {
        child.parentNativeSessionId = parent.nativeSessionId
        missing.delete(child.nativeSessionId)
        if (!missing.size) return
      }
    }
  }
}

async function locate(home: string, opts: LocateOptions): Promise<SessionRef[]> {
  const found: SessionRef[] = []
  const indices = new Map<string, Map<string, string>>()
  for (const store of KIMI_STORES) {
    const root = join(home, store.root)
    const pattern = storeGlob('globs' in store ? store.globs.session : WIRE)
    const children = storeGlob('globs' in store && store.globs.children ? store.globs.children : CHILD_WIRE)
    const matches = (rel: string): boolean => {
      if (!pattern.test(rel) && !children.test(rel)) return false
      if (!opts.nativeSessionId) return true
      const { id, parent, root: sessionRoot } = sessionIdentity(rel)
      return sessionRoot !== null
        ? sessionRoot === opts.nativeSessionId.split('/')[0]
        : id === opts.nativeSessionId || parent === opts.nativeSessionId
    }
    for (const rel of await walkFiles(root, undefined, matches)) {
      const path = join(root, rel)
      const context = join(dirname(path), 'context.jsonl')
      const files = (await mtimeMs(context)) > 0 ? [path, context] : [path]
      found.push({ ...refForWire(path, path, indices), files, home, mtimeMs: await mtimeMs(path) })
    }
  }
  const refs = found.filter(ref => !opts.sinceMs || ref.mtimeMs >= opts.sinceMs)
  // Inventory stays a metadata operation. An explicit family read can recover a missing parent from its own wires.
  if (opts.nativeSessionId && refs.some(ref => ref.nativeSessionId.includes('/') && ref.parentNativeSessionId === null))
    await linkKimiFamily(found)
  const byId = new Map(found.map((ref) => [ref.nativeSessionId, ref]))
  const selected = (ref: SessionRef): boolean => {
    if (!opts.nativeSessionId || ref.nativeSessionId.split('/')[0] === opts.nativeSessionId) return true
    let id: string | null = ref.nativeSessionId
    const seen = new Set<string>()
    while (id !== null && !seen.has(id)) {
      if (id === opts.nativeSessionId) return true
      seen.add(id)
      id = byId.get(id)?.parentNativeSessionId ?? null
    }
    return false
  }
  const selectedRefs: SessionRef[] = []
  for (const ref of refs) {
    if (!selected(ref)) continue
    if (opts.cwd) {
      ref.cwd = (await fold(ref, 'summary', {})).cwd
      if (ref.cwd === null || !withinPath(ref.cwd, opts.cwd)) continue
    }
    selectedRefs.push(ref)
  }
  return selectedRefs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const kimiReader: HarnessSessionReader = foldedReader({ harness: HARNESS, aliases: ['kimi', 'kimi-cli'], format: FORMAT, globs: { session: WIRE, children: CHILD_WIRE }, stores: KIMI_STORES }, locate, fold)

function refForWire(path: string, storePath: string, indices?: Map<string, Map<string, string>>): SessionRef {
  const { id, parent, root } = sessionIdentity(storePath)
  let owner = parent
  if (root && id !== root && path === storePath && isAbsolute(path)) {
    const state = join(dirname(dirname(dirname(path))), 'state.json')
    const parents = indices?.get(state) ?? stateParents(state)
    indices?.set(state, parents)
    owner = parents.get(id) ?? null
  }
  return { harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: owner }
}

export function kimiRefForFile(path: string, storePath = path): SessionRef {
  return refForWire(path, storePath)
}
