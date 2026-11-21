import { basename, join } from 'node:path'
import type { BuildMode } from '../builder.js'
import type { HarnessSessionReader, ReadOptions, SessionRef } from '../schema.js'
import { fileRecords } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles, withinPath } from '../stores.js'
import { foldedReader, runFold } from './fold.js'
import { headRecord } from './head.js'
import { createFold } from './pi.js'
import { primeHeaderFacts, primeParentNativeSessionId } from './prime-header.js'

export { isPrimeSessionHeader, primeParentNativeSessionId } from './prime-header.js'

const FORMAT = 'prime.session-jsonl' as const
const STORE = STORES[FORMAT]
const HARNESS = 'prime'

function idFromName(path: string): string {
  return basename(path, '.jsonl').replace(/^[\dTZ.:-]+_/u, '')
}

export function primeRefForFile(path: string): SessionRef {
  return { harness: HARNESS, format: FORMAT, nativeSessionId: idFromName(path), path, files: [path], home: null, cwd: null, mtimeMs: 0, parentNativeSessionId: null }
}

async function fold(ref: SessionRef, mode: BuildMode, opts: ReadOptions) {
  const records = fileRecords(ref.path, { strict: opts.corruption === 'strict', signal: opts.signal })
  return runFold(createFold(ref, mode, records.stats, HARNESS, FORMAT), records)
}

export const primeReader: HarnessSessionReader = foldedReader({ harness: HARNESS, refForFile: primeRefForFile, aliases: [], format: FORMAT }, async (home, opts) => {
  const root = join(home, STORE.root)
  const pattern = storeGlob(STORE.files[0], opts.nativeSessionId)
  const refs: SessionRef[] = []
  for (const rel of await walkFiles(root)) {
    if (!pattern.test(rel)) continue
    const path = join(root, rel)
    const mtime = await mtimeMs(path)
    if (opts.sinceMs && mtime < opts.sinceMs) continue
    const header = primeHeaderFacts(await headRecord(path, (r) => r.type === 'session', 1))
    // An unmarked header is Pi-family ambiguous: keep the store filename identity it always had.
    const id = header ? header.id : idFromName(rel)
    const cwd = header && typeof header.cwd === 'string' ? header.cwd : null
    const parentSession = header && typeof header.parentSession === 'string' ? header.parentSession : null
    if (opts.nativeSessionId && id !== opts.nativeSessionId && idFromName(rel) !== opts.nativeSessionId) continue
    if (opts.cwd && (cwd === null || !withinPath(cwd, opts.cwd))) continue
    refs.push({
      harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path], home, cwd, mtimeMs: mtime,
      parentNativeSessionId: parentSession === null ? null : primeParentNativeSessionId(parentSession),
    })
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}, fold)
