/**
 * Pi: `~/.pi/agent/sessions/<encoded cwd>/<timestamp>_<session id>.jsonl`, one entry per line.
 *
 * The first entry is the `session` header (id, cwd). Conversation entries are `message` entries
 * whose `message.role` is `user`, `assistant` or `toolResult`. Each assistant message records the
 * provider and model it was sent to, its usage (input, output and cache counts are disjoint, with a
 * cost breakdown), its stop reason and, on a failure, the provider's error message. Tool calls are
 * `toolCall` blocks inside assistant content, answered by `toolResult` messages keyed by
 * `toolCallId`. Entries form a tree through `parentId`; branches share one file.
 */
import { basename, join } from 'node:path'
import { SessionBuilder, count, isRecord, sessionError, str, textOf, usageOrNull, type BuildMode } from '../builder.js'
import type { HarnessSessionReader, LocateOptions, Part, ReadOptions, SessionRef, TokenUsage } from '../schema.js'
import { fileRecords, type RecordSource, type SourceStats } from '../source.js'
import { runFold, type SessionFold } from './fold.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { headRecord } from './head.js'

const FORMAT = 'pi.session-jsonl' as const
const STORE = STORES[FORMAT]
const HARNESS = 'pi'

function usageOf(value: unknown): { usage: TokenUsage | null; cost: number | null } {
  if (!isRecord(value)) return { usage: null, cost: null }
  const cost = isRecord(value.cost) ? count(value.cost.total) : null
  return {
    usage: usageOrNull({
      input: count(value.input),
      output: count(value.output),
      reasoning: count(value.reasoning),
      cacheRead: count(value.cacheRead),
      cacheWrite: count(value.cacheWrite),
    }),
    cost,
  }
}

function contentParts(content: unknown, ref: string): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  const parts: Part[] = []
  if (!Array.isArray(content)) return parts
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking') parts.push({ type: 'reasoning', text: str(block.thinking) ?? '', redacted: block.redacted === true })
    else if (block.type === 'image') parts.push({ type: 'attachment', mediaType: str(block.mimeType) ?? 'image', ref: `inline:${ref}` })
  }
  return parts
}

/** Session ids are the part of the file name after the timestamp: `<timestamp>_<id>.jsonl`. */
function idFromName(path: string): string {
  return basename(path, '.jsonl').replace(/^[\dTZ.:-]+_/u, '')
}

export function createFold(ref: SessionRef, mode: BuildMode, stats: SourceStats): SessionFold {
  const builder = new SessionBuilder(HARNESS, FORMAT, EVIDENCE[FORMAT].servedModel, mode, ref.nativeSessionId, ref.parentNativeSessionId)
  let previousId: string | null = null
  let branches = 0
  let compactions = 0
  let aborted: { at: string | null; message: string | null } | null = null

  const observe = (entry: Record<string, unknown>): void => {
    const entryAt = builder.seen(entry.timestamp)
    const id = str(entry.id) ?? `${builder.nativeSessionId}:${stats.line}`
    const parentId = str(entry.parentId)
    if (entry.type === 'session') {
      if (typeof entry.id === 'string') builder.nativeSessionId = entry.id
      builder.cwd = str(entry.cwd)
      previousId = null
      return
    }
    if (parentId !== null && previousId !== null && parentId !== previousId) branches += 1
    previousId = id
    if (entry.type === 'compaction') {
      compactions += 1
      if (typeof entry.summary === 'string') {
        builder.message({ id, role: 'user', actor: 'injected', at: entryAt, modelCallId: null, parts: [{ type: 'text', text: entry.summary }] })
      }
      return
    }
    if (entry.type !== 'message' || !isRecord(entry.message)) return
    const message = entry.message
    const at = entryAt ?? builder.seen(message.timestamp)
    const role = str(message.role)

    if (role === 'user') {
      aborted = null
      builder.message({ id, role: 'user', actor: ref.parentNativeSessionId ? 'subagent-spawn' : 'human', at, modelCallId: null, parts: contentParts(message.content, id) })
      return
    }
    if (role === 'toolResult') {
      const callId = str(message.toolCallId) ?? `${id}:result`
      builder.message({ id, role: 'tool', actor: 'tool-result', at, modelCallId: null, parts: [{ type: 'tool-result', toolCallId: callId }] })
      const content = message.content
      const single = Array.isArray(content) && content.length === 1 && isRecord(content[0]) && content[0].type === 'text'
      builder.toolResult(callId, {
        output: single ? (content as Array<Record<string, unknown>>)[0]!.text : (content ?? null),
        text: textOf(content),
        isError: message.isError === true,
        at,
        name: str(message.toolName) ?? undefined,
        messageId: id,
        details: message.details ?? null,
      })
      return
    }
    if (role === 'assistant') {
      const stopReason = str(message.stopReason)
      const errorText = str(message.errorMessage)
      const failed = stopReason === 'error'
      const { usage, cost } = usageOf(message.usage)
      // A failed request returned no response, so no model served it; the model it was sent to
      // stays in the profile and the request, not here.
      builder.modelCall({
        id,
        at,
        provider: failed ? null : str(message.provider),
        servedModel: failed ? null : str(message.model),
        requestedModel: str(message.model),
        usage,
        costUsd: cost,
        stopReason,
        error: failed ? sessionError('error', errorText ?? 'Pi assistant stopped with an error', at) : null,
      })
      const parts = contentParts(message.content, id)
      const content = Array.isArray(message.content) ? message.content : []
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'toolCall') continue
        const callId = str(block.id) ?? `${id}:call:${parts.length}`
        parts.push({ type: 'tool-call', toolCallId: callId })
        const input = block.arguments ?? block.input ?? null
        builder.toolCall({ id: callId, name: str(block.name) ?? 'tool', input, inputText: typeof input === 'string' ? input : null, at, messageId: id })
      }
      builder.message({ id, role: 'assistant', actor: failed ? 'injected' : 'agent', at, modelCallId: id, parts: failed && parts.length === 0 && errorText ? [{ type: 'text', text: errorText }] : parts })
      aborted = stopReason === 'aborted' ? { at, message: errorText } : null
      return
    }
    // Harness-injected messages (system prompts, extension messages, shell executions).
    if (role === 'system' || role === 'custom' || role === 'bashExecution') {
      builder.message({ id, role: role === 'system' ? 'system' : 'user', actor: 'injected', at, modelCallId: null, parts: contentParts(message.content ?? message.output, id) })
    }
  }

  const finish = (): SessionBuilder => {

    builder.source(stats)
    if (branches > 0) builder.gap(`${branches} entries continue an earlier entry rather than the previous one (the session branched); all branches are read in file order`)
    if (compactions > 0) builder.gap(`${compactions} compaction entries replaced earlier context`)
    builder.inferEnding(aborted ? { at: aborted.at, error: aborted.message ? sessionError('aborted', aborted.message, aborted.at, null) : null } : undefined)
    return builder
  }
  return { builder, observe, finish }
}

export async function fold(ref: SessionRef, mode: BuildMode, options: ReadOptions, source: RecordSource = fileRecords(ref.path, { strict: options.corruption === 'strict', signal: options.signal })): Promise<SessionBuilder> {
  return runFold(createFold(ref, mode, source.stats), source)
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
    const header = await headRecord(path, (r) => r.type === 'session', 1)
    const cwd = header ? str(header.cwd) : null
    if (opts.cwd && (cwd === null || !cwd.startsWith(opts.cwd))) continue
    const id = (header && str(header.id)) ?? idFromName(rel)
    if (opts.nativeSessionId && id !== opts.nativeSessionId && idFromName(rel) !== opts.nativeSessionId) continue
    refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path], home, cwd, mtimeMs: mtime, parentNativeSessionId: null })
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export const piReader: HarnessSessionReader = {
  harness: HARNESS,
  aliases: ['pi-coding-agent', 'pi-agent'],
  formats: [FORMAT],
  stores: [STORE],
  globs: { session: STORE.files[0] },
  evidence: EVIDENCE[FORMAT],
  locate: (home, opts = {}) => locate(home, opts),
  async read(ref, opts = {}) {
    return (await fold(ref, 'full', opts)).build()
  },
  async summarize(ref, opts = {}) {
    return (await fold(ref, 'summary', opts)).summary()
  },
}

export function piRefForFile(path: string): SessionRef {
  return { harness: HARNESS, format: FORMAT, nativeSessionId: idFromName(path), path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null }
}
