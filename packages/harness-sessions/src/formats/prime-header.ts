import { isRecord } from '@tangle-network/agent-core'

/** The header facts a marked Prime session proves. */
export interface PrimeHeaderFacts {
  id: string
  cwd: unknown
  timestamp: unknown
  parentSession: unknown
  rlmDepth: number
}

/**
 * Whether a session record is a Prime session header. Prime marks its headers with a recursion
 * `rlmDepth` (0 on a root session and on a user fork); the Pi family shares the rest of the header
 * shape, including `version`, without ever writing that field. An unmarked header is therefore
 * ambiguous and stays with its historical filename identity.
 */
export function isPrimeSessionHeader(record: unknown): boolean {
  if (!isRecord(record)) return false
  if (record.type !== 'session') return false
  if (typeof record.id !== 'string' || record.id.length === 0) return false
  const depth = record.rlmDepth
  return typeof depth === 'number' && Number.isInteger(depth) && depth >= 0
}

/** Narrow a parsed first line to Prime header facts, or null when the header is not marked Prime. */
export function primeHeaderFacts(record: Record<string, unknown> | null): PrimeHeaderFacts | null {
  if (record === null || !isPrimeSessionHeader(record)) return null
  return {
    id: record.id as string,
    cwd: record.cwd,
    timestamp: record.timestamp,
    parentSession: record.parentSession,
    rlmDepth: record.rlmDepth as number,
  }
}

/** The parent's native session ID from a recorded `parentSession` reference (a session file path or a plain ID). The reference is never dereferenced. */
export function primeParentNativeSessionId(parentSession: string): string {
  const name = parentSession.replace(/\\/gu, '/').split('/').pop() ?? parentSession
  return name.replace(/\.jsonl$/u, '') || parentSession
}
