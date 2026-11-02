import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { sandboxEventsSession, toChatMessages, toOtlpSpans } from '../src/index.js'

// A settled agent result from a real Discovery run, with long strings cut to 400 characters.
const fixture = new URL('./fixtures/sandbox-events/settled-result.json', import.meta.url)

describe('sandboxEventsSession', () => {
  it('reads a real settled result into one whole episode', async () => {
    const { content, events } = JSON.parse(await readFile(fixture, 'utf8')) as { content: string; events: unknown[] }
    const session = sandboxEventsSession({ harness: 'opencode', nativeSessionId: 'expr-calculator-20261023b:root', task: 'Build the calculator.', answer: content, events })
    const chat = toChatMessages(session)

    expect(chat[0]).toEqual({ role: 'user', content: 'Build the calculator.' })
    expect(chat.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name)).toEqual([
      'agent-runtime-coordination_knowledge_record',
      'agent-runtime-coordination_knowledge_record',
      'agent-runtime-coordination_observe_agent',
    ])
    expect(chat.filter((m) => m.role === 'tool')).toHaveLength(3)
    // The reasoning part is re-sent under one id in a second message and must not repeat.
    expect(chat.filter((m) => m.reasoning_content !== undefined)).toHaveLength(1)
    expect(chat.at(-1)).toMatchObject({ role: 'assistant', content })
    expect(session.toolCalls.every((c) => c.status === 'completed')).toBe(true)
    expect(toOtlpSpans(session).length).toBeGreaterThan(0)
  })
})
