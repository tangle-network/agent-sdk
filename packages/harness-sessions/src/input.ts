/**
 * Reading a session that is already in memory: JSONL text (a retained copy, a blob) or records a
 * caller already parsed. The same fold as reading the file, so a session reads the same whichever
 * way its bytes arrive.
 */
import type { BuildMode, SessionBuilder } from './builder.js'
import { fold as claudeCodeFold } from './formats/claude-code.js'
import { fold as codexFold } from './formats/codex.js'
import { fold as piFold } from './formats/pi.js'
import { readerFor } from './registry.js'
import type { HarnessSession, ReadOptions, SessionRef, SessionSummary } from './schema.js'
import { arrayRecords, textRecords, type RecordSource } from './source.js'

export type SessionInput = { text: string } | { records: readonly unknown[] }

export interface SessionInputInit {
  /** The native session id when the caller knows it; JSONL formats also read it from their records. */
  nativeSessionId?: string
  parentNativeSessionId?: string | null
  /** Names the source in integrity records (a path, a blob ref). */
  label?: string
}

type Fold = (ref: SessionRef, mode: BuildMode, options: ReadOptions, source: RecordSource) => Promise<SessionBuilder>

const FOLDS: Record<string, Fold> = {
  'claude-code': claudeCodeFold,
  codex: codexFold,
  pi: piFold,
}

async function foldInput(harness: string, input: SessionInput, init: SessionInputInit, mode: BuildMode, options: ReadOptions): Promise<SessionBuilder> {
  const reader = readerFor(harness)
  const fold = FOLDS[reader.harness]
  if (!fold) throw new Error(`${reader.harness} sessions are a store, not a record stream; read them with readerFor('${reader.harness}').read`)
  const label = init.label ?? `${reader.harness}:${init.nativeSessionId ?? 'input'}`
  const source = 'text' in input ? textRecords(input.text, label, { strict: options.corruption === 'strict' }) : arrayRecords(input.records, label)
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
  return fold(ref, mode, options, source)
}

/** Read a JSONL-format session (Claude Code, Codex, Pi) from text or parsed records. */
export async function readSessionInput(harness: string, input: SessionInput, init: SessionInputInit = {}, options: ReadOptions = {}): Promise<HarnessSession> {
  return (await foldInput(harness, input, init, 'full', options)).build()
}

/** Summarize a JSONL-format session from text or parsed records. */
export async function summarizeSessionInput(harness: string, input: SessionInput, init: SessionInputInit = {}, options: ReadOptions = {}): Promise<SessionSummary> {
  return (await foldInput(harness, input, init, 'summary', options)).summary()
}
