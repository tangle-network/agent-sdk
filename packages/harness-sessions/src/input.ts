/**
 * Reading a session that is already in memory: JSONL text (a retained copy, a blob) or records a
 * caller already parsed. The same fold as reading the file, driven synchronously, so a session
 * reads the same whichever way its bytes arrive.
 */
import type { BuildMode, SessionBuilder } from './builder.js'
import { createFold as claudeCodeFold } from './formats/claude-code.js'
import { createFold as codexFold } from './formats/codex.js'
import type { SessionFold } from './formats/fold.js'
import { createFold as piFold } from './formats/pi.js'
import { readerFor } from './registry.js'
import type { HarnessSession, ReadOptions, SessionRef, SessionSummary } from './schema.js'
import { arrayRecordsSync, memoryStats, textRecordsSync, type SourceStats } from './source.js'

export type SessionInput = { text: string } | { records: readonly unknown[] }

export interface SessionInputInit {
  /** The native session id when the caller knows it; JSONL formats also read it from their records. */
  nativeSessionId?: string
  /** Set for a subagent's own transcript; its records are the subagent's, not sidechain noise. */
  parentNativeSessionId?: string | null
  /** Names the source in integrity records (a path, a blob ref). */
  label?: string
}

type CreateFold = (ref: SessionRef, mode: BuildMode, stats: SourceStats) => SessionFold

const FOLDS: Record<string, CreateFold> = {
  'claude-code': claudeCodeFold,
  codex: codexFold,
  pi: piFold,
}

function foldInput(harness: string, input: SessionInput, init: SessionInputInit, mode: BuildMode, options: Pick<ReadOptions, 'corruption'>): SessionBuilder {
  const reader = readerFor(harness)
  const create = FOLDS[reader.harness]
  if (!create) throw new Error(`${reader.harness} sessions are a store, not a record stream; read them with readerFor('${reader.harness}').read`)
  const label = init.label ?? `${reader.harness}:${init.nativeSessionId ?? 'input'}`
  const stats = memoryStats(label, 'text' in input ? input.text : undefined)
  const ref: SessionRef = {
    harness: reader.harness,
    format: reader.formats[0]!,
    nativeSessionId: init.nativeSessionId ?? label,
    path: label,
    files: [],
    home: null,
    cwd: null,
    mtimeMs: 0,
    parentNativeSessionId: init.parentNativeSessionId ?? null,
  }
  const fold = create(ref, mode, stats)
  const records = 'text' in input ? textRecordsSync(input.text, stats, { strict: options.corruption === 'strict' }) : arrayRecordsSync(input.records, stats)
  for (const record of records) fold.observe(record)
  return fold.finish()
}

/** Read a JSONL-format session (Claude Code, Codex, Pi) from text or parsed records, synchronously. */
export function readSessionInput(harness: string, input: SessionInput, init: SessionInputInit = {}, options: Pick<ReadOptions, 'corruption'> = {}): HarnessSession {
  return foldInput(harness, input, init, 'full', options).build()
}

/** Summarize a JSONL-format session from text or parsed records, synchronously. */
export function summarizeSessionInput(harness: string, input: SessionInput, init: SessionInputInit = {}, options: Pick<ReadOptions, 'corruption'> = {}): SessionSummary {
  return foldInput(harness, input, init, 'summary', options).summary()
}
