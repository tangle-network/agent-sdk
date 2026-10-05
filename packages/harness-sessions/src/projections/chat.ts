import type { HarnessSession, SessionMessage } from '../schema.js'

/** agent-eval's chat-with-tools message (`src/rollout/schema.ts`), declared here structurally. */
export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  reasoning_content?: string
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
  is_copied_context?: boolean
}

export interface ChatProjectionOptions {
  /** Keep messages the harness injected (environment context, instructions). Default true. */
  injected?: boolean
  /** Keep `system` messages. Default true. */
  system?: boolean
}

function texts(message: SessionMessage, type: 'text' | 'reasoning'): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: typeof type }> => p.type === type)
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join('\n')
}

function resultContent(output: unknown, text: string | null): string {
  if (text !== null) return text
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return ''
  return JSON.stringify(output)
}

/**
 * The session as chat-with-tools messages: each assistant message carries its text, reasoning
 * and tool calls; each tool result is a `tool` message answering its call. Content is complete;
 * a projection that needs less trims it itself.
 */
export function toChatMessages(session: HarnessSession, options: ChatProjectionOptions = {}): ChatMessage[] {
  const keepInjected = options.injected !== false
  const keepSystem = options.system !== false
  const calls = new Map(session.toolCalls.map((c) => [c.id, c]))
  const out: ChatMessage[] = []
  for (const message of session.messages) {
    if (message.actor === 'injected' && !keepInjected) continue
    if (message.role === 'system') {
      if (keepSystem) out.push({ role: 'system', content: texts(message, 'text') })
      continue
    }
    if (message.role === 'user') {
      const content = texts(message, 'text')
      if (content.length === 0 && !message.parts.some((p) => p.type === 'attachment')) continue
      out.push({ role: 'user', content })
      continue
    }
    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type !== 'tool-result') continue
        const call = calls.get(part.toolCallId)
        out.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          ...(call ? { name: call.name } : {}),
          content: resultContent(call?.result?.output, call?.result?.text ?? null),
        })
      }
      continue
    }
    const text = texts(message, 'text')
    const reasoning = texts(message, 'reasoning')
    const toolCalls: ChatToolCall[] = []
    for (const part of message.parts) {
      if (part.type !== 'tool-call') continue
      const call = calls.get(part.toolCallId)
      toolCalls.push({
        id: part.toolCallId,
        type: 'function',
        function: { name: call?.name ?? 'unknown', arguments: call?.inputText ?? JSON.stringify(call?.input ?? {}) },
      })
    }
    if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue
    out.push({
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
  }
  return out
}
