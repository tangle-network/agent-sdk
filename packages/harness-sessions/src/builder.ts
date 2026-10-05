import type {
  HarnessSession,
  ModelCall,
  Part,
  SessionEnding,
  SessionError,
  SessionFormatId,
  SessionMessage,
  SessionSummary,
  SessionToolCall,
  TokenUsage,
} from './schema.js'
import { HARNESS_SESSION_SCHEMA } from './schema.js'
import type { SourceStats } from './source.js'

export type BuildMode = 'full' | 'summary'

/** An ISO-8601 instant from an ISO string, epoch milliseconds or epoch seconds; null otherwise. */
export function isoTime(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : new Date(ms).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds before 2001-09-09 in milliseconds are below 1e12; nothing here predates that.
    return new Date(value < 1e12 ? value * 1000 : value).toISOString()
  }
  return null
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Parse tool arguments recorded as text; keep the text when it is not JSON. */
export function argumentsOf(raw: unknown): { input: unknown; inputText: string | null } {
  if (typeof raw !== 'string') return { input: raw ?? null, inputText: null }
  try {
    return { input: JSON.parse(raw), inputText: raw }
  } catch {
    return { input: raw, inputText: raw }
  }
}

/** The text of an output that is text, or of the text blocks in a content-block array. */
export function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const texts: string[] = []
  for (const block of value) {
    if (isRecord(block) && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.length > 0 ? texts.join('\n') : null
}

/** The HTTP status in a provider error message such as `unexpected status 500 Internal Server Error`. */
export function httpStatusIn(text: string | null | undefined): number | null {
  if (!text) return null
  const match = /\b(?:status(?: code)?|HTTP)[^\d]{0,4}([1-5]\d\d)\b/iu.exec(text) ?? /^([45]\d\d)\b/u.exec(text.trim())
  return match ? Number(match[1]) : null
}

function addUsage(total: TokenUsage, usage: TokenUsage): void {
  for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'] as const) {
    const value = usage[key]
    if (value !== null) total[key] = (total[key] ?? 0) + value
  }
}

export function usageOrNull(usage: TokenUsage): TokenUsage | null {
  return usage.input === null && usage.output === null && usage.reasoning === null
    && usage.cacheRead === null && usage.cacheWrite === null
    ? null
    : usage
}

/** The key a served model is counted under: `provider/model`, or the bare model with no provider. */
export function servedModelKey(call: Pick<ModelCall, 'provider' | 'servedModel'>): string | null {
  if (call.servedModel === null) return null
  return call.provider === null ? call.servedModel : `${call.provider}/${call.servedModel}`
}

/**
 * Folds one session's records into a {@link HarnessSession}. Every format reader drives this
 * builder, and `read` and `summarize` share the same fold: in summary mode the builder keeps the
 * counts, the model calls and the ending, and drops message and tool-call content, so a 700 MB
 * rollout is summarized without holding its outputs.
 */
export class SessionBuilder {
  readonly full: boolean
  nativeSessionId: string
  parentNativeSessionId: string | null
  cwd: string | null = null
  private startedAt: string | null = null
  private endedAt: string | null = null
  private readonly messages: SessionMessage[] = []
  private readonly messageById = new Map<string, SessionMessage>()
  private readonly toolCalls = new Map<string, SessionToolCall>()
  private readonly toolCallIds = new Set<string>()
  private readonly openToolCalls = new Set<string>()
  private lastRole: SessionMessage['role'] | null = null
  private inputsSinceLastCall = 0
  private toolCallCount = 0
  private replies = 0
  readonly modelCalls: ModelCall[] = []
  private readonly modelCallById = new Map<string, ModelCall>()
  private readonly children: HarnessSession['children'] = []
  private readonly gaps: string[] = []
  private readonly sources: Array<{ path: string; sha256: string; bytes: number }> = []
  private unparsed = 0
  private truncated = false
  private sessionUsage: TokenUsage | null | undefined
  private ending: SessionEnding = { status: 'open', error: null, at: null }

  constructor(
    readonly harness: string,
    readonly format: SessionFormatId,
    readonly modelSource: HarnessSession['modelSource'],
    mode: BuildMode,
    nativeSessionId: string,
    parentNativeSessionId: string | null = null,
  ) {
    this.full = mode === 'full'
    this.nativeSessionId = nativeSessionId
    this.parentNativeSessionId = parentNativeSessionId
  }

  /** Record an instant the session was active. Returns the normalized instant. */
  seen(value: unknown): string | null {
    const at = isoTime(value)
    if (at === null) return null
    if (this.startedAt === null || at < this.startedAt) this.startedAt = at
    if (this.endedAt === null || at > this.endedAt) this.endedAt = at
    return at
  }

  message(message: SessionMessage): SessionMessage {
    if (message.role === 'assistant' && message.actor === 'agent') this.replies += 1
    // Only new input re-opens a turn: harness bookkeeping (a compaction summary, environment
    // context) after a failed call does not.
    if (message.role === 'user' && (message.actor === 'human' || message.actor === 'subagent-spawn')) this.inputsSinceLastCall += 1
    this.lastRole = message.role
    if (this.full) {
      this.messages.push(message)
      this.messageById.set(message.id, message)
    }
    return message
  }

  /** Add parts to a message already recorded (one API response written over several records). */
  appendParts(messageId: string, parts: Part[]): void {
    if (!this.full) return
    const message = this.messageById.get(messageId)
    if (message) message.parts.push(...parts)
  }

  hasMessage(messageId: string): boolean {
    return this.messageById.has(messageId)
  }

  /** A tool call the agent made. Its part is added to `messageId` when the message is held. */
  toolCall(call: { id: string; name: string; input: unknown; inputText: string | null; at: string | null; messageId: string }): void {
    if (this.toolCallIds.has(call.id)) return
    this.toolCallIds.add(call.id)
    this.openToolCalls.add(call.id)
    this.toolCallCount += 1
    if (!this.full) return
    this.toolCalls.set(call.id, {
      id: call.id,
      name: call.name,
      input: call.input,
      inputText: call.inputText,
      result: null,
      status: 'pending',
      startedAt: call.at,
      endedAt: null,
      messageId: call.messageId,
    })
  }

  /** The result of a tool call. A result whose call was not recorded becomes a call of its own. */
  toolResult(id: string, result: { output: unknown; text: string | null; isError: boolean; at: string | null; name?: string; messageId: string }): void {
    if (!this.toolCallIds.has(id)) {
      this.toolCall({ id, name: result.name ?? 'unknown', input: null, inputText: null, at: result.at, messageId: result.messageId })
      this.gap(`tool result ${id} has no recorded call`)
    }
    this.openToolCalls.delete(id)
    if (!this.full) return
    const call = this.toolCalls.get(id)
    if (!call) return
    call.result = { output: result.output, text: result.text, isError: result.isError, at: result.at }
    call.status = result.isError ? 'error' : 'completed'
    call.endedAt = result.at
  }

  modelCall(call: ModelCall): ModelCall {
    this.inputsSinceLastCall = 0
    this.modelCalls.push(call)
    this.modelCallById.set(call.id, call)
    return call
  }

  getModelCall(id: string): ModelCall | undefined {
    return this.modelCallById.get(id)
  }

  child(nativeSessionId: string, toolCallId: string | null): void {
    if (this.children.some((c) => c.nativeSessionId === nativeSessionId)) return
    this.children.push({ nativeSessionId, toolCallId })
  }

  gap(text: string): void {
    // Keep the first occurrences; a damaged file can produce one gap per record.
    if (this.gaps.length < 200) this.gaps.push(text)
  }

  source(stats: SourceStats | { path: string; sha256: string; bytes: number; unparsed?: number; tornTail?: boolean }): void {
    this.sources.push({ path: stats.path, sha256: stats.sha256, bytes: stats.bytes })
    this.unparsed += stats.unparsed ?? 0
    if (stats.tornTail) {
      this.truncated = true
      this.gap(`${stats.path}: last record was still being written when the copy was taken`)
    }
  }

  markTruncated(reason: string): void {
    this.truncated = true
    this.gap(reason)
  }

  /** The harness's own session total, when it records one; it wins over the per-call sum. */
  setSessionUsage(usage: TokenUsage | null): void {
    this.sessionUsage = usage
  }

  end(ending: SessionEnding): void {
    this.ending = ending
  }

  /**
   * The ending every format shares, from what the session holds when the records run out:
   * `aborted` when the harness recorded an abort last; `error` when the last model call failed
   * and no new input followed it; `completed` when the last model call succeeded, every tool call
   * has its result and the agent spoke last; `open` otherwise (the turn was still running, or the
   * process died mid-turn).
   */
  inferEnding(aborted?: { at: string | null; error: SessionError | null }): void {
    if (aborted) {
      this.ending = { status: 'aborted', error: aborted.error, at: aborted.at }
      return
    }
    const last = this.modelCalls[this.modelCalls.length - 1]
    if (last?.error && this.inputsSinceLastCall === 0) {
      this.ending = { status: 'error', error: last.error, at: last.error.at ?? last.at }
      return
    }
    if (last && this.openToolCalls.size === 0 && this.lastRole === 'assistant') {
      this.ending = { status: 'completed', error: null, at: this.endedAt }
      return
    }
    this.ending = { status: 'open', error: null, at: null }
  }

  get endingStatus(): SessionEnding['status'] {
    return this.ending.status
  }

  private usage(): TokenUsage | null {
    if (this.sessionUsage !== undefined) return this.sessionUsage
    const total: TokenUsage = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null }
    for (const call of this.modelCalls) if (call.usage) addUsage(total, call.usage)
    return usageOrNull(total)
  }

  private servedModels(): Record<string, number> {
    const models: Record<string, number> = {}
    for (const call of this.modelCalls) {
      const key = servedModelKey(call)
      if (key !== null) models[key] = (models[key] ?? 0) + 1
    }
    return models
  }

  build(): HarnessSession {
    const toolCalls = [...this.toolCalls.values()]
    for (const call of toolCalls) {
      if (call.status === 'pending' && this.ending.status !== 'open') call.status = 'interrupted'
    }
    return {
      schema: HARNESS_SESSION_SCHEMA,
      harness: this.harness,
      format: this.format,
      nativeSessionId: this.nativeSessionId,
      parentNativeSessionId: this.parentNativeSessionId,
      cwd: this.cwd,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      messages: this.messages,
      toolCalls,
      modelCalls: this.modelCalls,
      servedModels: this.servedModels(),
      modelSource: this.modelSource,
      usage: this.usage(),
      ending: this.ending,
      children: this.children,
      integrity: {
        sourceFiles: this.sources,
        unparsedRecords: this.unparsed,
        truncated: this.truncated,
        gaps: this.gaps,
      },
    }
  }

  summary(): SessionSummary {
    return {
      harness: this.harness,
      format: this.format,
      nativeSessionId: this.nativeSessionId,
      parentNativeSessionId: this.parentNativeSessionId,
      modelCalls: this.modelCalls.length,
      replies: this.replies,
      toolCalls: this.toolCallCount,
      servedModels: this.servedModels(),
      modelSource: this.modelSource,
      usage: this.usage(),
      ending: this.ending,
      unparsedRecords: this.unparsed,
      bytes: this.sources.reduce((sum, s) => sum + s.bytes, 0),
      truncated: this.truncated,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    }
  }
}

export function sessionError(kind: string, message: string | null | undefined, at: string | null, httpStatus?: number | null): SessionError {
  const text = message ?? ''
  return { kind, message: text, httpStatus: httpStatus ?? httpStatusIn(text), at }
}
