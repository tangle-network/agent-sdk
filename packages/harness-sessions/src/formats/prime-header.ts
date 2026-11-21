import { isRecord } from '@tangle-network/agent-core'

interface PrimeSessionHeader {
  type: 'session'
  id: string
  rlmDepth: number
  cwd?: unknown
  timestamp?: unknown
  parentSession?: unknown
}

/**
 * Whether a session record is a Prime session header. Prime marks its headers with a recursion
 * `rlmDepth` (0 on a root session and on a user fork); the Pi family shares the rest of the header
 * shape, including `version`, without ever writing that field. An unmarked header is therefore
 * ambiguous and stays with its historical filename identity.
 */
export function isPrimeSessionHeader(record: unknown): record is PrimeSessionHeader {
  if (!isRecord(record)) return false
  if (record.type !== 'session') return false
  if (typeof record.id !== 'string' || record.id.length === 0) return false
  const depth = record.rlmDepth
  return typeof depth === 'number' && Number.isInteger(depth) && depth >= 0
}

/** The parent's native session ID from a recorded `parentSession` reference (a session file path or a plain ID). The reference is never dereferenced. */
export function primeParentNativeSessionId(parentSession: string): string {
  const name = parentSession.replace(/\\/gu, '/').split('/').pop() ?? parentSession
  return name.replace(/\.jsonl$/u, '') || parentSession
}
