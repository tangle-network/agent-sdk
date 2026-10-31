import { basename, join } from 'node:path'
import type { BuildMode } from '../builder.js'
import type { HarnessSessionReader, ReadOptions, SessionRef } from '../schema.js'
import { fileRecords } from '../source.js'
import { EVIDENCE, STORES, mtimeMs, storeGlob, walkFiles } from '../stores.js'
import { runFold } from './fold.js'
import { createFold } from './pi.js'

const FORMAT = 'prime.session-jsonl' as const
const STORE = STORES[FORMAT]
const HARNESS = 'prime'

function idFromName(path: string): string {
  return basename(path, '.jsonl').replace(/^[\dTZ.:-]+_/u, '')
}

async function fold(ref: SessionRef, mode: BuildMode, opts: ReadOptions) {
  const records = fileRecords(ref.path, { strict: opts.corruption === 'strict', signal: opts.signal })
  return runFold(createFold(ref, mode, records.stats, HARNESS, FORMAT), records)
}

export const primeReader: HarnessSessionReader = {
  harness: HARNESS, aliases: [], formats: [FORMAT], stores: [STORE], globs: { session: STORE.files[0] }, evidence: EVIDENCE[FORMAT],
  async locate(home, opts = {}) {
    const root = join(home, STORE.root)
    const pattern = storeGlob(STORE.files[0], opts.nativeSessionId)
    const refs: SessionRef[] = []
    for (const rel of await walkFiles(root)) {
      if (!pattern.test(rel)) continue
      const path = join(root, rel)
      const id = idFromName(rel)
      if (opts.nativeSessionId && id !== opts.nativeSessionId) continue
      refs.push({ harness: HARNESS, format: FORMAT, nativeSessionId: id, path, files: [path], home, cwd: null, mtimeMs: await mtimeMs(path), parentNativeSessionId: null })
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  },
  async read(ref, opts: ReadOptions = {}) { return (await fold(ref, 'full', opts)).build() },
  async summarize(ref, opts: ReadOptions = {}) { return (await fold(ref, 'summary', opts)).summary() },
}
