import type { BuildMode, SessionBuilder } from './builder.js'
import { createFold as claudeCodeFold } from './formats/claude-code.js'
import { createFold as codexFold } from './formats/codex.js'
import type { SessionFold } from './formats/fold.js'
import { createFold as kimiFold } from './formats/kimi.js'
import { createFold as factoryFold } from './formats/factory.js'
import { createFold as piFold } from './formats/pi.js'
import { readerFor } from './registry.js'
import type { HarnessSession, ReadOptions, SessionRef, SessionSummary } from './schema.js'
import { arrayRecordsSync, memoryStats, textRecordsSync, type SourceStats } from './source.js'

export type SessionInput = { text: string } | { records: readonly unknown[] }

export interface SessionInputInit {
  nativeSessionId?: string
  parentNativeSessionId?: string | null
  label?: string
  firstLine?: number
}

type CreateFold = (ref: SessionRef, mode: BuildMode, stats: SourceStats) => SessionFold

const FOLDS: Record<string, CreateFold> = {
  'claude-code': claudeCodeFold,
  codex: codexFold,
  pi: piFold,
  'kimi-code': kimiFold,
  'factory-droids': (ref, mode, stats) => factoryFold(ref, mode, stats),
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
  const firstLine = init.firstLine ?? 1
  const records = 'text' in input
    ? textRecordsSync(input.text, stats, { strict: options.corruption === 'strict', firstLine })
    : arrayRecordsSync(input.records, stats, firstLine)
  for (const record of records) fold.observe(record)
  return fold.finish()
}

export function readSessionInput(harness: string, input: SessionInput, init: SessionInputInit = {}, options: Pick<ReadOptions, 'corruption'> = {}): HarnessSession {
  return foldInput(harness, input, init, 'full', options).build()
}

export function summarizeSessionInput(harness: string, input: SessionInput, init: SessionInputInit = {}, options: Pick<ReadOptions, 'corruption'> = {}): SessionSummary {
  return foldInput(harness, input, init, 'summary', options).summary()
}
