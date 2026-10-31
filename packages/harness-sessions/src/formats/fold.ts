import type { SessionBuilder } from '../builder.js'
import type { RecordSource } from '../source.js'

export interface SessionFold {
  builder: SessionBuilder
  observe(record: Record<string, unknown>): void
  finish(): SessionBuilder
}

export async function runFold(fold: SessionFold, source: RecordSource): Promise<SessionBuilder> {
  for await (const record of source.records) fold.observe(record)
  return fold.finish()
}
