import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { CODEX_HOME_RULE, isCodexHome, storeGlob } from './catalog.js'
import type { NativeSessionStore } from './schema.js'
import { isMissing } from './source.js'

export { assertStoreRoot, CODEX_HOME_RULE, EVIDENCE, isCodexHome, SESSION_FORMAT_IDS, STORES, storeGlob, withinPath } from './catalog.js'

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

/** Names of the directories (or links to them) directly in `dir`. A missing dir has none. */
async function childDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

/**
 * Every Codex home under `home`, by `CODEX_HOME_RULE`: `home` itself when it is one (a fleet seat's
 * `codex` passed as a store root), `.codex` and each `.codex-<name>` in it, and each acct account
 * home. `$CODEX_HOME` and `$ACCT_CONFIG` describe this process's own HOME, so they apply only when
 * `home` is that HOME; another HOME (a store root, a capture) is read by its layout alone. Homes
 * that resolve to one directory, such as an account home linked to `~/.codex`, count once.
 */
export async function codexHomes(home: string): Promise<string[]> {
  const own = resolve(home) === resolve(process.env.HOME || homedir())
  const candidates = isCodexHome(home) ? [home] : []
  for (const name of await childDirs(home)) if (CODEX_HOME_RULE.siblings.test(name)) candidates.push(join(home, name))
  if (own && process.env.CODEX_HOME) candidates.push(resolve(process.env.CODEX_HOME))
  const accounts = own && process.env.ACCT_CONFIG ? join(resolve(process.env.ACCT_CONFIG), 'codex') : join(home, CODEX_HOME_RULE.accounts)
  for (const name of await childDirs(accounts)) candidates.push(join(accounts, name))
  const seen = new Set<string>()
  const homes: string[] = []
  for (const dir of candidates) {
    let real: string
    try {
      real = await realpath(dir)
      if (!(await stat(real)).isDirectory()) continue
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    if (seen.has(real)) continue
    seen.add(real)
    homes.push(dir)
  }
  return homes
}
