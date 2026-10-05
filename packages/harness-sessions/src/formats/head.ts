import { newSourceStats, readJsonlRecords } from '../source.js'

/**
 * The first record among a session file's first `limit` records that satisfies `match`, read
 * without consuming the rest of the file. Used to learn a session's id and cwd while locating.
 */
export async function headRecord(
  path: string,
  match: (record: Record<string, unknown>) => boolean,
  limit = 64,
): Promise<Record<string, unknown> | null> {
  let seen = 0
  try {
    for await (const record of readJsonlRecords(path, newSourceStats(path))) {
      if (match(record)) return record
      seen += 1
      if (seen >= limit) return null
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
  return null
}
