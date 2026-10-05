import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { storeGlob } from './catalog.js'
import type { NativeSessionStore } from './schema.js'
import { isMissing } from './source.js'

export { assertStoreRoot, EVIDENCE, SESSION_FORMAT_IDS, STORES, storeGlob } from './catalog.js'

/** Every file under `dir`, as paths relative to it with `/` separators. Missing dirs yield none. */
export async function walkFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = []
  const visit = async (current: string): Promise<void> => {
    signal?.throwIfAborted()
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) out.push(relative(dir, path).split(sep).join('/'))
    }
  }
  await visit(dir)
  return out.sort()
}

/** Files under `home` that one store glob matches, as absolute paths. */
export async function storeFiles(home: string, store: NativeSessionStore, glob: string, nativeSessionId?: string): Promise<string[]> {
  const root = join(home, store.root)
  const pattern = storeGlob(glob, nativeSessionId)
  return (await walkFiles(root)).filter((path) => pattern.test(path)).map((path) => join(root, path))
}

export async function mtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
}
