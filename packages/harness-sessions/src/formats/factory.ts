/**
 * Factory Droid: `~/.factory/sessions/<encoded cwd>/<session id>.jsonl` plus a
 * `<session id>.settings.json` beside it.
 *
 * The JSONL holds a `session_start` line (id, cwd) and `message` lines whose `message.content[]`
 * carries Anthropic-style blocks (`text`, `thinking`, `tool_use`, `tool_result`). Each assistant
 * line is one model response. The transcript records no model and no per-response usage: the
 * settings file holds the configured model and the session's token totals, so the model here has
 * source `turn-context` (configured, not served) and usage is the session total.
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { SessionBuilder, count, isRecord, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, LocateOptions, NativeSessionStore, Part, ReadOptions, SessionRef, TokenUsage } from '../schema.js'
import { fileRecords, isMissing, type RecordSource, type SourceStats } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { runFold, type SessionFold } from './fold.js'
import { headRecord } from './head.js'

const FORMAT = 'factory.session-jsonl' as const
const STORE = STORES[FORMAT]
const HARNESS = 'factory-droids'

/** The settings file Factory rewrites beside each transcript. */
export const FACTORY_SETTINGS_STORE: NativeSessionStore = {
  root: '.factory/sessions',
  files: ['*/{id}.settings.json'],
  write: 'json-rewrite',
  shared: false,
  format: FORMAT,
}

interface FactorySettings {
  model: string | null
  usage: TokenUsage | null
}

function settingsOf(value: unknown): FactorySettings {
  if (!isRecord(value)) return { model: null, usage: null }
  const tokens = isRecord(value.tokenUsage) ? value.tokenUsage : null
  return {
    model: str(value.model),
    usage: tokens === null ? null : usageOrNull({
      input: count(tokens.inputTokens),
      output: count(tokens.outputTokens),
      reasoning: count(tokens.thinkingTokens),
      cacheRead: count(tokens.cacheReadTokens),
      cacheWrite: count(tokens.cacheCreationTokens),
    }),
  }
}

const INJECTED = /^\s*(?:<system-reminder>|<[a-z-]+>)/u

export function createFold(ref: SessionRef, mode: BuildMode, stats: SourceStats, settings: FactorySettings = { model: null, usage: null }): SessionFold {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)

  const observe = (record: Record<string, unknown>): void => {
    if (record.type === 'session_start') {
      if (typeof record.id === 'string') builder.nativeSessionId = record.id
      builder.cwd = str(record.cwd)
      return
    }
    if (record.type !== 'message' || !isRecord(record.message)) return
    const at = builder.seen(record.timestamp)
    const id = str(record.id) ?? `${builder.nativeSessionId}:${stats.line}`
    const message = record.message
    const content = Array.isArray(message.content) ? message.content.filter(isRecord) : []
    if (message.role === 'assistant') {
      const parts: Part[] = []
      builder.modelCall({ id, at, provider: null, servedModel: settings.model, requestedModel: settings.model, usage: null, costUsd: null, stopReason: null, error: null })
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text })
        else if (block.type === 'thinking') parts.push({ type: 'reasoning', text: str(block.thinking) ?? '', redacted: !block.thinking })
        else if (block.type === 'tool_use' && typeof block.id === 'string') {
          parts.push({ type: 'tool-call', toolCallId: block.id })
          builder.toolCall({ id: block.id, name: str(block.name) ?? 'unknown', input: block.input ?? null, inputText: null, at, messageId: id })
        }
      }
      builder.message({ id, role: 'assistant', actor: 'agent', at, modelCallId: id, parts })
      return
    }
    const toolParts: Part[] = []
    const textParts: Part[] = []
    for (const block of content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolParts.push({ type: 'tool-result', toolCallId: block.tool_use_id })
        builder.toolResult(block.tool_use_id, { output: block.content ?? null, text: textOf(block.content), isError: block.is_error === true, at, messageId: `${id}:tool` })
      } else if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push({ type: 'text', text: block.text })
      }
    }
    if (toolParts.length > 0) builder.message({ id: `${id}:tool`, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: toolParts })
    if (textParts.length > 0) {
      const first = textParts[0]
      const injected = id.startsWith('context-') || (first?.type === 'text' && INJECTED.test(first.text))
      builder.message({ id, role: 'user', actor: injected ? 'injected' : ref.parentNativeSessionId ? 'subagent-spawn' : 'human', at, modelCallId: null, parts: textParts })
    }
  }

  const finish = (): SessionBuilder => {
    builder.source(stats)
    // Factory records only the session's token totals, in its settings file.
    if (settings.usage !== null) builder.setSessionUsage(settings.usage)
    builder.inferEnding()
    return builder
  }
  return { builder, observe, finish }
}

async function readSettings(path: string): Promise<FactorySettings> {
  try {
    return settingsOf(JSON.parse(await readFile(path.replace(/\.jsonl$/u, '.settings.json'), 'utf8')))
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return { model: null, usage: null }
    throw error
  }
}

export async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions, source: RecordSource = fileRecords(ref.path, { strict: options.corruption === 'strict', signal: options.signal })): Promise<SessionBuilder> {
  return runFold(createFold(ref, mode, source.stats, await readSettings(ref.path)), source)
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
    const settings = path.replace(/\.jsonl$/u, '.settings.json')
    refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: basename(path, '.jsonl'), path, files: (await mtimeMs(settings)) > 0 ? [path, settings] : [path], home, cwd: null, mtimeMs: mtime, parentNativeSessionId: null })
  }
  const filtered: SessionRef[] = []
  for (const ref of refs) {
    if (opts.cwd) {
      // The directory name encodes the cwd with `/` as `-`; the session_start line holds it exactly.
      const head = await headRecord(ref.path, (r) => r.type === 'session_start', 1)
      const cwd = head ? str(head.cwd) : null
      ref.cwd = cwd
      if (!cwd || !cwd.startsWith(opts.cwd)) continue
    }
    filtered.push(ref)
  }
  return filtered.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const factoryReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['factory', 'droid'],
  formats: [FORMAT],
  stores: [STORE, FACTORY_SETTINGS_STORE],
  evidence: EVIDENCE[FORMAT],
  locate: (home, opts = {}) => locate(home, opts),
  async read(ref, opts = {}) {
    return (await fold(ref, 'full', opts)).build()
  },
  async summarize(ref, opts = {}) {
    return (await fold(ref, 'summary', opts)).summary()
  },
}

export function factoryRefForFile(path: string): SessionRef {
  return { harness: HARNESS, format: FORMAT, nativeSessionId: basename(path, '.jsonl'), path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null }
}

