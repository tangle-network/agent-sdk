import type { BuildMode, SessionBuilder } from '../builder.js'
import type { HarnessSessionReader, LocateOptions, ReadOptions, SessionFormatId, SessionRef } from '../schema.js'
import type { RecordSource } from '../source.js'
import { EVIDENCE, STORES } from '../stores.js'

export interface SessionFold {
  builder: SessionBuilder
  observe(record: Record<string, unknown>): void
  finish(): SessionBuilder
}

export async function runFold(fold: SessionFold, source: RecordSource): Promise<SessionBuilder> {
  for await (const record of source.records) fold.observe(record)
  return fold.finish()
}

/** A reader: what differs between harnesses is how a session is found and folded. */
export function foldedReader(
  reader: Pick<HarnessSessionReader, 'harness' | 'aliases'> & Partial<Pick<HarnessSessionReader, 'stores' | 'globs'>> & { format: SessionFormatId },
  locate: (home: string, opts: LocateOptions) => Promise<SessionRef[]>,
  fold: (ref: SessionRef, mode: BuildMode, opts: ReadOptions) => Promise<SessionBuilder>,
): HarnessSessionReader {
  const store = STORES[reader.format]
  return {
    harness: reader.harness,
    aliases: reader.aliases,
    formats: [reader.format],
    stores: reader.stores ?? [store],
    globs: reader.globs ?? { session: store.files[0] },
    evidence: EVIDENCE[reader.format],
    locate: (home, opts = {}) => locate(home, opts),
    read: async (ref, opts = {}) => (await fold(ref, 'full', opts)).build(),
    summarize: async (ref, opts = {}) => (await fold(ref, 'summary', opts)).summary(),
  }
}
