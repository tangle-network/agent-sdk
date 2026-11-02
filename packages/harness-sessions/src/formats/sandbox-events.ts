import { isRecord } from '@tangle-network/agent-core'
import { SessionBuilder, str } from '../builder.js'
import { EVIDENCE } from '../stores.js'
import type { HarnessSession } from '../schema.js'

const FORMAT = 'sandbox.events' as const

export interface SandboxEventsRun {
  harness: string
  nativeSessionId: string
  /** The task the agent was given; the stream never repeats it. */
  task: string
  /** The settled final answer; a stream can stop before its last text part lands. */
  answer: string
  events: readonly unknown[]
}

/**
 * The newest copy of each part, in first-seen order. A part is re-sent whole as it grows, and a
 * reasoning or text part can keep its id across messages while its text accumulates, so a later
 * message holds only what it added.
 */
function partsOf(events: readonly unknown[]): Record<string, unknown>[] {
  const parts = new Map<string, Record<string, unknown>>()
  const newest = new Map<string, { message: unknown; text: unknown }>()
  const carried = new Map<string, string>()
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'message.part.updated' || !isRecord(event.data)) continue
    const part = event.data.part
    if (!isRecord(part) || typeof part.id !== 'string') continue
    const seen = newest.get(part.id)
    if (typeof seen?.text === 'string' && seen.message !== part.messageID) carried.set(part.id, seen.text)
    newest.set(part.id, { message: part.messageID, text: part.text })
    const prior = carried.get(part.id) ?? ''
    const added = typeof part.text === 'string' && part.text.startsWith(prior) ? part.text.slice(prior.length).trim() : part.text
    parts.set(`${str(part.messageID)}:${part.id}`, { ...part, text: added })
  }
  return [...parts.values()]
}

/** One agent's run as the Sandbox streamed it: every harness reaches this stream as the same parts. */
export function sandboxEventsSession(run: SandboxEventsRun): HarnessSession {
  const { nativeSessionId: id } = run
  const builder = new SessionBuilder(run.harness, FORMAT, EVIDENCE[FORMAT].servedModel, 'full', id)
  builder.message({ id: `${id}:task`, role: 'user', actor: 'subagent-spawn', at: null, modelCallId: null, parts: [{ type: 'text', text: run.task }] })
  let turn: string | null = null
  let turns = 0
  let said = ''
  const assistant = (): string => {
    turn ??= builder.message({ id: `${id}:turn:${(turns += 1)}`, role: 'assistant', actor: 'agent', at: null, modelCallId: null, parts: [] }).id
    return turn
  }
  for (const part of partsOf(run.events)) {
    if (part.type === 'tool') {
      const state = isRecord(part.state) ? part.state : {}
      const time = isRecord(state.time) ? state.time : {}
      const call = `${str(part.messageID)}:${str(part.callID) ?? str(part.id)}`
      const messageId = assistant()
      builder.appendParts(messageId, [{ type: 'tool-call', toolCallId: call }])
      builder.toolCall({ id: call, name: str(part.tool) ?? 'unknown', input: state.input ?? null, inputText: null, at: builder.seen(time.start), messageId })
      turn = null
      if (state.status !== 'completed' && state.status !== 'failed' && state.status !== 'error') continue
      const isError = state.status !== 'completed'
      const output = isError ? (state.error ?? null) : (state.output ?? null)
      const at = builder.seen(time.end)
      builder.message({ id: `${call}:result`, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: call }] })
      builder.toolResult(call, { output, text: typeof output === 'string' ? output : null, isError, at, messageId: `${call}:result` })
    } else if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string' && part.text.length > 0) {
      builder.appendParts(assistant(), [part.type === 'text' ? { type: 'text', text: part.text } : { type: 'reasoning', text: part.text, redacted: false }])
      if (part.type === 'text') said = part.text
    }
  }
  if (!said.trim().endsWith(run.answer.trim())) builder.appendParts(assistant(), [{ type: 'text', text: run.answer }])
  builder.end({ status: 'completed', error: null, at: null })
  return builder.build()
}
