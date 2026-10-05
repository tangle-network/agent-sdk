import type { SessionBuilder } from '../builder.js'
import type { RecordSource } from '../source.js'

/**
 * One format's fold, driven by whoever has the records: `observe` takes each record in order and
 * `finish` closes the session. Reading a file drives it asynchronously; text or parsed records in
 * memory drive it synchronously. Either way it is the same fold.
 */
export interface SessionFold {
  builder: SessionBuilder
  observe(record: Record<string, unknown>): void
  finish(): SessionBuilder
}

export async function runFold(fold: SessionFold, source: RecordSource): Promise<SessionBuilder> {
  for await (const record of source.records) fold.observe(record)
  return fold.finish()
}
