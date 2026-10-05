import {
  contractSpan,
  deriveHexId,
  llmSpan,
  toolSpan,
  type ContractSpan,
} from '@tangle-network/agent-trace-contract'
import type { HarnessSession } from '../schema.js'

export interface OtlpProjectionOptions {
  /** Characters of message text kept per span attribute. Default 8000; 0 keeps none. */
  contentChars?: number
}

const cap = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n)}…`)

/**
 * The session as contract spans: one AGENT span for the session, one LLM span per model call
 * (served model, tokens, cost, error status) and one TOOL span per tool call under the model call
 * that made it. Ids derive from the native session id, so two exports of one session join.
 */
export function toOtlpSpans(session: HarnessSession, options: OtlpProjectionOptions = {}): ContractSpan[] {
  const chars = options.contentChars ?? 8000
  const traceId = deriveHexId(`${session.harness}:${session.nativeSessionId}`, 16)
  const spanId = (key: string): string => deriveHexId(`${session.harness}:${session.nativeSessionId}:${key}`, 8)
  const rootId = spanId('session')
  const start = session.startedAt ?? new Date(0).toISOString()
  const end = session.endedAt ?? start
  const spans: ContractSpan[] = [
    contractSpan({
      traceId,
      spanId: rootId,
      parentSpanId: null,
      name: 'session',
      kind: 'AGENT',
      startTime: start,
      endTime: end,
      status: session.ending.status === 'error'
        ? { code: 'STATUS_CODE_ERROR', message: session.ending.error?.message ?? 'session ended in error' }
        : session.ending.status === 'completed' ? { code: 'STATUS_CODE_OK' } : { code: 'STATUS_CODE_UNSET' },
      attributes: {
        'tangle.sessionId': session.nativeSessionId,
        'tangle.harness': session.harness,
        'tangle.harness_session.format': session.format,
        'tangle.harness_session.ending': session.ending.status,
        ...(session.parentNativeSessionId ? { 'tangle.harness_session.parent': session.parentNativeSessionId } : {}),
      },
    }),
  ]
  const messageByCall = new Map<string, HarnessSession['messages'][number]>()
  for (const message of session.messages) if (message.modelCallId) messageByCall.set(message.modelCallId, message)
  const llmIdByMessage = new Map<string, string>()
  for (const call of session.modelCalls) {
    const id = spanId(`llm:${call.id}`)
    const message = messageByCall.get(call.id)
    if (message) llmIdByMessage.set(message.id, id)
    const text = message ? message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n') : ''
    spans.push(llmSpan({
      traceId,
      spanId: id,
      parentSpanId: rootId,
      name: 'llm.call',
      startTime: call.at ?? start,
      status: call.error ? { code: 'STATUS_CODE_ERROR', message: call.error.message } : { code: 'STATUS_CODE_OK' },
      ...(call.servedModel ? { model: call.servedModel } : {}),
      ...(call.provider ? { system: call.provider } : {}),
      ...(call.usage?.input != null ? { inputTokens: call.usage.input } : {}),
      ...(call.usage?.output != null ? { outputTokens: call.usage.output } : {}),
      ...(call.costUsd != null ? { costUsd: call.costUsd } : {}),
      attributes: {
        ...(call.usage?.cacheRead != null ? { 'gen_ai.usage.cache_read.input_tokens': call.usage.cacheRead } : {}),
        ...(call.usage?.cacheWrite != null ? { 'gen_ai.usage.cache_creation.input_tokens': call.usage.cacheWrite } : {}),
        ...(call.usage?.reasoning != null ? { 'gen_ai.usage.reasoning_tokens': call.usage.reasoning } : {}),
        ...(call.stopReason ? { 'gen_ai.response.finish_reasons': [call.stopReason] } : {}),
        ...(call.error?.httpStatus != null ? { 'http.response.status_code': call.error.httpStatus } : {}),
        'tangle.harness_session.model_source': session.modelSource,
        ...(chars > 0 && text ? { 'output.value': cap(text, chars) } : {}),
      },
    }))
  }
  for (const call of session.toolCalls) {
    spans.push(toolSpan({
      traceId,
      spanId: spanId(`tool:${call.id}`),
      parentSpanId: llmIdByMessage.get(call.messageId) ?? rootId,
      name: `tool.${call.name}`,
      toolName: call.name,
      startTime: call.startedAt ?? start,
      endTime: call.endedAt ?? call.startedAt ?? start,
      status: call.status === 'error'
        ? { code: 'STATUS_CODE_ERROR', message: cap(call.result?.text ?? 'tool reported an error', 500) }
        : call.status === 'completed' ? { code: 'STATUS_CODE_OK' } : { code: 'STATUS_CODE_UNSET' },
      attributes: {
        'gen_ai.tool.call.id': call.id,
        'tangle.tool.status': call.status,
        ...(chars > 0 ? { 'input.value': cap(call.inputText ?? JSON.stringify(call.input ?? null), chars) } : {}),
        ...(chars > 0 && call.result?.text ? { 'output.value': cap(call.result.text, chars) } : {}),
      },
    }))
  }
  return spans
}
