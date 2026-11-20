import { basename, join } from 'node:path'
import type { BuildMode } from '../builder.js'
import type { HarnessSessionReader, ReadOptions, SessionRef } from '../schema.js'
import { fileRecords } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { foldedReader, runFold } from './fold.js'
import { createFold } from './pi.js'

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
    const ref = primeRefForFile(path)
    if (opts.nativeSessionId && ref.nativeSessionId !== opts.nativeSessionId) continue
    refs.push({ ...ref, home, mtimeMs: await mtimeMs(path) })
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}, fold)
