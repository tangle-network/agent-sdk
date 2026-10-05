import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, normalize, relative, sep } from 'node:path'
import type { NativeSessionStore, SessionEvidenceSources, SessionFormatId } from './schema.js'
import { isMissing } from './source.js'

/**
 * Store layouts, relative to the HOME a harness ran with. These are the declarations the sidecar's
 * harness session contract imports: the capture path copies exactly these files, and readers find
 * sessions only through them.
 */
export const STORES = {
  'claude-code.projects-jsonl': {
    root: '.claude/projects',
    files: ['*/{id}.jsonl', '*/{id}/subagents/**/*.jsonl'],
    write: 'jsonl-append',
    shared: false,
    format: 'claude-code.projects-jsonl',
  },
  'codex.rollout-jsonl': {
    root: '.codex/sessions',
    files: ['*/*/*/rollout-*-{id}.jsonl'],
    write: 'jsonl-append',
    shared: false,
    format: 'codex.rollout-jsonl',
  },
  'opencode.sqlite': {
    root: '.local/share/opencode',
    files: ['opencode.db', 'opencode.db-wal', 'opencode.db-shm'],
    write: 'sqlite-wal',
    shared: true,
    format: 'opencode.sqlite',
  },
  'pi.session-jsonl': {
    root: '.pi/agent/sessions',
    files: ['**/*_{id}.jsonl'],
    write: 'jsonl-append',
    shared: false,
    format: 'pi.session-jsonl',
  },
  'factory.session-jsonl': {
    root: '.factory/sessions',
    files: ['*/{id}.jsonl'],
    write: 'jsonl-append',
    shared: false,
    format: 'factory.session-jsonl',
  },
  'kimi.session-dir': {
    root: '.kimi/sessions',
    files: ['*/{id}/wire.jsonl', '*/{id}/context.jsonl'],
    write: 'jsonl-append',
    shared: false,
    format: 'kimi.session-dir',
  },
} as const satisfies Partial<Record<SessionFormatId, NativeSessionStore>>

/** Where each format's served model, usage and ending error come from. */
export const EVIDENCE = {
  'claude-code.projects-jsonl': { servedModel: 'provider-response', usage: 'per-response', endingError: 'session-record' },
  'codex.rollout-jsonl': { servedModel: 'turn-context', usage: 'cumulative', endingError: 'session-record' },
  'opencode.sqlite': { servedModel: 'session-record', usage: 'per-response', endingError: 'session-record' },
  'pi.session-jsonl': { servedModel: 'session-record', usage: 'per-response', endingError: 'session-record' },
  'kimi.session-dir': { servedModel: 'none', usage: 'per-response', endingError: 'session-record' },
  'factory.session-jsonl': { servedModel: 'turn-context', usage: 'session-total', endingError: 'none' },
} as const satisfies Partial<Record<SessionFormatId, SessionEvidenceSources>>

const REGEX_SPECIALS = /[.+^$()|[\]\\]/gu

/**
 * Compile one store glob. `*` matches within a path segment, `**` matches any number of
 * segments, and `{id}` matches the native session id: the literal id when one is given, any
 * segment text otherwise (the reader then takes the id from the session's own header).
 */
export function storeGlob(glob: string, nativeSessionId?: string): RegExp {
  let pattern = ''
  for (let i = 0; i < glob.length; i += 1) {
    const rest = glob.slice(i)
    if (rest.startsWith('{id}')) {
      pattern += nativeSessionId === undefined ? '[^/]+' : nativeSessionId.replace(REGEX_SPECIALS, '\\$&').replace(/[*?{}]/gu, '\\$&')
      i += 3
    } else if (rest.startsWith('**/')) {
      pattern += '(?:[^/]+/)*'
      i += 2
    } else if (rest.startsWith('**')) {
      pattern += '.*'
      i += 1
    } else if (glob[i] === '*') {
      pattern += '[^/]*'
    } else if (glob[i] === '?') {
      pattern += '[^/]'
    } else {
      pattern += glob[i]!.replace(REGEX_SPECIALS, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`, 'u')
}

/** Validate a store root: relative, normalized, no `..`. */
export function assertStoreRoot(root: string): void {
  if (root.startsWith('/') || normalize(root) !== root || root.split('/').includes('..')) {
    throw new Error(`store root must be a normalized path relative to HOME: ${root}`)
  }
}

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
