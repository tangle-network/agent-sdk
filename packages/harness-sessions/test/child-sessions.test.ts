/** Real retained Kimi parent/child wires; provenance and redaction are beside the fixtures. */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateTraceSpans } from '@tangle-network/agent-trace-contract'
import { kimiReader, kimiRefForFile, readSessionInput, toOtlpSpans } from '../src/index.js'

const fixture = join(import.meta.dirname, 'fixtures', 'kimi', 'parent')
const childIds = ['id-011afd997439', 'id-4fb3cf18797e']

describe('recorded Kimi child sessions', () => {
  it('discovers native child wires and projects their own recorded work exactly once', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-child-capture-'))
    try {
      const root = join(home, '.kimi', 'sessions', 'capture', 'parent')
      await cp(fixture, root, { recursive: true })
      const refs = await kimiReader.locate(home, { nativeSessionId: 'parent' })
      expect(refs.map((ref) => ref.nativeSessionId).sort()).toEqual([...childIds, 'parent'].sort())
      const sessions = await Promise.all(refs.map(async (ref) => {
        const session = await kimiReader.read(ref)
        const summary = await kimiReader.summarize(ref)
        expect(summary.modelCalls).toBe(session.modelCalls.length)
        expect(summary.toolCalls).toBe(session.toolCalls.length)
        expect(summary.usage).toEqual(session.usage)
        expect(summary.parentNativeSessionId).toBe(session.parentNativeSessionId)
        expect(readSessionInput('kimi-code', { text: await readFile(ref.path, 'utf8') }, {
          nativeSessionId: ref.nativeSessionId,
          parentNativeSessionId: ref.parentNativeSessionId,
        }).usage).toEqual(session.usage)
        const spans = toOtlpSpans(session, { contentChars: 0 })
        expect(validateTraceSpans(spans).findings.filter((finding) => finding.severity === 'error')).toEqual([])
        expect(spans[0]!.attributes['tangle.harness_session.parent'] ?? null).toBe(ref.parentNativeSessionId)
        expect(session.servedModels).toEqual({})
        return session
      }))
      const parent = sessions.find((session) => session.nativeSessionId === 'parent')!
      expect(parent.children.map((child) => child.nativeSessionId).sort()).toEqual(childIds)
      for (const child of parent.children) {
        expect(parent.toolCalls.some((call) => call.id === child.toolCallId)).toBe(true)
      }
      expect(parent.usage).toEqual({ input: 35022, output: 3981, reasoning: null, cacheRead: 302848, cacheWrite: 0 })
      const children = sessions.filter((session) => session.nativeSessionId !== 'parent')
      expect(children.map((session) => session.modelCalls.length).sort((a, b) => a - b)).toEqual([11, 28])
      for (const child of children) {
        expect(child.parentNativeSessionId).toBe('parent')
        expect(child.messages.some((message) => message.role === 'user')).toBe(true)
        expect(child.messages.filter((message) => message.role === 'user').every((message) => message.actor === 'subagent-spawn')).toBe(true)
        expect(kimiRefForFile(refs.find((ref) => ref.nativeSessionId === child.nativeSessionId)!.path).parentNativeSessionId).toBe('parent')
        const selected = await kimiReader.locate(home, { nativeSessionId: child.nativeSessionId })
        expect(selected.map((ref) => ref.nativeSessionId)).toEqual([child.nativeSessionId])
      }
      expect(sessions.reduce((sum, session) => sum + session.modelCalls.length, 0)).toBe(48)
      expect(sessions.reduce((sum, session) => sum + session.toolCalls.length, 0)).toBe(112)
      expect(sessions.reduce((sum, session) => sum + (session.usage?.input ?? 0), 0)).toBe(183251)
      expect(sessions.reduce((sum, session) => sum + (session.usage?.output ?? 0), 0)).toBe(19511)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
