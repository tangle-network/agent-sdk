import { isRecord } from '../builder.js'
import type { HarnessSession, ModelCall, SessionError, SessionMessage, SessionToolCall, TokenUsage } from '../schema.js'

/** One tool invocation in a turn, previewed for storage beside a post. */
export interface TurnToolCall {
  name: string
  input_preview?: string
  file_path?: string
  result_preview?: string
  is_error?: boolean
}

/** One turn of agent activity, the blog's trace unit (drewstone.github.io tools/harness/types.ts). */
export interface Turn {
  role: 'user' | 'assistant' | 'system' | 'tool'
  seq?: number
  text?: string
  text_summary?: string
  tool_calls?: number
  tool_names?: string[]
  tool_call_details?: TurnToolCall[]
  files_touched?: string[]
  had_thinking?: boolean
  /** The model that answered this turn, as the session recorded it. */
  model?: string
  usage?: TokenUsage
  /** The error the model call ended with, when it failed. */
  error?: SessionError
  ts: string
}

export interface TurnOptions {
  /** Working directory to make touched paths relative to. Defaults to the session cwd. */
  cwd?: string | null
  /** Characters kept in `text`. Default 8000. */
  textChars?: number
  /** Characters kept in `text_summary`. Default 280. */
  summaryChars?: number
  /** Characters kept in a tool input or result preview. Default 600. */
  previewChars?: number
  /**
   * The files a tool call touched. Defaults to the path of an edit or write tool and the files a
   * patch names; a caller with its own notion (paths mentioned anywhere in the input) passes it.
   */
  filesOf?: (call: SessionToolCall) => string[]
}

export function summarizeText(text: string, n: number): string {
  const t = text.replace(/\s+/gu, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|edit|write|multiedit|patch|apply_patch|str_replace_editor|create_file)$/u

function stringField(input: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined
  for (const key of keys) if (typeof input[key] === 'string') return input[key] as string
  return undefined
}

/** Paths a patch touches, from `*** Update File:` / `*** Add File:` / `*** Delete File:` headers. */
function patchPaths(text: string): string[] {
  return [...text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu)].map((m) => m[1]!.trim())
}

function touched(call: SessionToolCall): string[] {
  if (!EDIT_TOOLS.test(call.name)) return []
  const path = stringField(call.input, 'file_path', 'filePath', 'path', 'notebook_path')
  if (path) return [path]
  const text = typeof call.input === 'string' ? call.input : stringField(call.input, 'patch', 'input', 'content') ?? call.inputText ?? ''
  return patchPaths(text)
}

function inputPreview(call: SessionToolCall): string {
  const input = call.input
  const command = stringField(input, 'command', 'cmd')
  if (command) return command
  if (Array.isArray(isRecord(input) ? input.command : undefined)) return ((input as Record<string, unknown>).command as unknown[]).join(' ')
  const oldString = stringField(input, 'old_string', 'oldString')
  if (oldString !== undefined) {
    const head = (s: string): string => s.split('\n').slice(0, 3).join('\n')
    return `- ${head(oldString)}\n+ ${head(stringField(input, 'new_string', 'newString') ?? '')}`
  }
  const content = stringField(input, 'content')
  if (content !== undefined && EDIT_TOOLS.test(call.name)) return content.split('\n').slice(0, 6).join('\n')
  const pattern = stringField(input, 'pattern')
  if (pattern) {
    const path = stringField(input, 'path')
    return path ? `${pattern}  in  ${path}` : pattern
  }
  const path = stringField(input, 'file_path', 'filePath', 'path')
  if (path) return path
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return ''
  }
}

function text(message: SessionMessage, type: 'text' | 'reasoning'): string {
  return message.parts.filter((p) => p.type === type).map((p) => (p as { text: string }).text).join('\n')
}

/**
 * The session as the blog's turns: one turn per human message and per assistant message, with
 * the tool calls an assistant message made, the files they touched, the model that answered,
 * its usage and the error it ended with.
 */
export function toTurns(session: HarnessSession, options: TurnOptions = {}): Turn[] {
  const textChars = options.textChars ?? 8000
  const summaryChars = options.summaryChars ?? 280
  const previewChars = options.previewChars ?? 600
  const root = (options.cwd ?? session.cwd ?? '').replace(/\/$/u, '')
  const relativize = (path: string): string => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)
  const calls = new Map(session.toolCalls.map((c) => [c.id, c]))
  const modelCalls = new Map<string, ModelCall>(session.modelCalls.map((c) => [c.id, c]))
  const turns: Turn[] = []
  let seq = 0
  for (const message of session.messages) {
    const ts = message.at ?? ''
    if (message.role === 'user') {
      const body = text(message, 'text')
      if (!body) continue
      turns.push({ role: 'user', seq: seq++, text: body.length > textChars ? summarizeText(body, textChars) : body, ts })
      continue
    }
    if (message.role !== 'assistant') continue
    const body = text(message, 'text')
    const toolCalls = message.parts.filter((p) => p.type === 'tool-call').map((p) => calls.get((p as { toolCallId: string }).toolCallId)).filter((c): c is SessionToolCall => c !== undefined)
    const call = message.modelCallId ? modelCalls.get(message.modelCallId) : undefined
    if (!body && toolCalls.length === 0 && !call?.error) continue
    const filesOf = options.filesOf ?? touched
    const files = toolCalls.flatMap(filesOf).map(relativize)
    const details: TurnToolCall[] = toolCalls.map((c) => {
      const preview = inputPreview(c)
      const path = (options.filesOf ?? touched)(c)[0]
      const result = c.result?.text ?? (typeof c.result?.output === 'string' ? (c.result.output as string) : undefined)
      return {
        name: c.name,
        ...(preview ? { input_preview: summarizeText(preview, previewChars) } : {}),
        ...(path ? { file_path: relativize(path) } : {}),
        ...(result ? { result_preview: summarizeText(result, previewChars) } : {}),
        ...(c.result?.isError ? { is_error: true } : {}),
      }
    })
    const model = call?.servedModel ?? undefined
    turns.push({
      seq: seq++,
      role: 'assistant',
      ...(body ? { text: body.length > textChars ? summarizeText(body, textChars) : body, text_summary: summarizeText(body, summaryChars) } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls.length, tool_names: [...new Set(toolCalls.map((c) => c.name))].slice(0, 6), tool_call_details: details } : {}),
      ...(files.length > 0 ? { files_touched: [...new Set(files)] } : {}),
      ...(message.parts.some((p) => p.type === 'reasoning') ? { had_thinking: true } : {}),
      ...(model ? { model } : {}),
      ...(call?.usage ? { usage: call.usage } : {}),
      ...(call?.error ? { error: call.error } : {}),
      ts,
    })
  }
  return turns
}

/** The model a session was answered by most often, or null when it recorded none. */
export function primaryModel(session: Pick<HarnessSession, 'modelCalls'>): string | null {
  const counts = new Map<string, number>()
  for (const call of session.modelCalls) if (call.servedModel) counts.set(call.servedModel, (counts.get(call.servedModel) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [model, n] of counts) if (n > bestCount) [best, bestCount] = [model, n]
  return best
}
