import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { isMissing } from '../source.js'

/** Bytes a head read takes at a time. A session's identifying record is almost always in the first. */
const HEAD_CHUNK = 64 * 1024

/**
 * The first record among a session file's first `limit` records that satisfies `match`. Locate
 * reads one for every session in a store, so it reads the file a small step at a time and stops
 * at the answer: never the rest of the file, and no digest of it. Lines parse as the session
 * reader parses them: a blank, malformed or non-object line is skipped, and a last line with no
 * newline counts when it is a whole record.
 */
export async function headRecord(
  path: string,
  match: (record: Record<string, unknown>) => boolean,
  limit = 64,
): Promise<Record<string, unknown> | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  let seen = 0
  // undefined: read on; null: `limit` records without a match; a record: the match.
  const take = (line: string): Record<string, unknown> | null | undefined => {
    const text = line.replace(/\r$/u, '')
    if (text.trim().length === 0) return undefined
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return undefined
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    if (match(value as Record<string, unknown>)) return value as Record<string, unknown>
    seen += 1
    return seen >= limit ? null : undefined
  }
  try {
    const decoder = new StringDecoder('utf8')
    const buffer = Buffer.allocUnsafe(HEAD_CHUNK)
    // The line being read, in pieces, so a record longer than a step is joined once.
    let pending: string[] = []
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, HEAD_CHUNK, position)
      if (bytesRead === 0) return take(pending.join('') + decoder.end()) ?? null
      position += bytesRead
      const text = decoder.write(buffer.subarray(0, bytesRead))
      let start = 0
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
        const found = take(pending.join('') + text.slice(start, end))
        pending = []
        if (found !== undefined) return found
        start = end + 1
      }
      pending.push(text.slice(start))
    }
  } finally {
    await handle.close()
  }
}
