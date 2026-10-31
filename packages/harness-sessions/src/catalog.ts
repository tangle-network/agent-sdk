/** Store layouts and evidence sources. No Node built-ins; the sidecar imports this module. */
import type { NativeSessionStore, SessionEvidenceSources, SessionFormatId } from './schema.js'

export const SESSION_FORMAT_IDS = [
  'claude-code.projects-jsonl',
  'codex.rollout-jsonl',
  'opencode.sqlite',
  'pi.session-jsonl',
  'kimi.session-dir',
  'factory.session-jsonl',
  'gemini.chat-json',
  'amp.thread-json',
  'forge.sqlite',
  'hermes.state-sqlite',
  'prime.session-jsonl',
  'openclaw.session-jsonl',
  'grok.acp-session-dir',
] as const

/** One catalog declaration owns append-only defaults and shared SQLite copy semantics. */
function store<const F extends SessionFormatId, const Files extends readonly string[]>(
  format: F, root: string, files: Files, write: NativeSessionStore['write'] = 'jsonl-append',
) {
  return { format, root, files, write, shared: write === 'sqlite-wal' }
}

/** Store layouts, relative to the HOME a harness ran with. */
export const STORES = {
  'claude-code.projects-jsonl': store('claude-code.projects-jsonl', '.claude/projects', [
    '*/{id}.jsonl', '*/{id}/subagents/**/*.jsonl',
  ]),
  'codex.rollout-jsonl': store('codex.rollout-jsonl', '.codex/sessions', ['*/*/*/rollout-*-{id}.jsonl']),
  'opencode.sqlite': store('opencode.sqlite', '.local/share/opencode', [
    'opencode.db', 'opencode.db-wal', 'opencode.db-shm',
  ], 'sqlite-wal'),
  'pi.session-jsonl': store('pi.session-jsonl', '.pi/agent/sessions', ['**/*_{id}.jsonl']),
  // A session directory: wire.jsonl (the event stream read here), context.jsonl and its rotated
  // context_N.jsonl copies, and state.json.
  'kimi.session-dir': store('kimi.session-dir', '.kimi/sessions', ['*/{id}/**', '*/{id}.jsonl']),
  'factory.session-jsonl': store('factory.session-jsonl', '.factory/sessions', [
    '*/{id}.jsonl', '*/{id}.settings.json',
  ]),
  'gemini.chat-json': store('gemini.chat-json', '.gemini/tmp', ['*/chats/session-*{id}*.json'], 'json-rewrite'),
  'amp.thread-json': store('amp.thread-json', '.local/share/amp/threads', ['{id}.json'], 'json-rewrite'),
  'forge.sqlite': store('forge.sqlite', '.forge', ['.forge.db', '.forge.db-wal', '.forge.db-shm'], 'sqlite-wal'),
  'hermes.state-sqlite': store('hermes.state-sqlite', '.hermes', ['state.db', 'state.db-wal', 'state.db-shm'], 'sqlite-wal'),
  'prime.session-jsonl': store('prime.session-jsonl', '.prime-provider/prime-agent-dirs', ['**/*_{id}.jsonl']),
  'openclaw.session-jsonl': store('openclaw.session-jsonl', '.openclaw/agents', ['**/{id}.jsonl']),
  'grok.acp-session-dir': store('grok.acp-session-dir', '.grok/sessions', ['*/{id}/updates.jsonl']),
} as const satisfies Record<SessionFormatId, NativeSessionStore>

/** Kimi Code's current and retained legacy layouts; the legacy catalog entry stays stable. */
export const KIMI_STORES = [
  { ...STORES['kimi.session-dir'], root: '.kimi-code/sessions', files: ['wd_*/{id}/**'], globs: { session: 'wd_*/{id}/agents/main/wire.jsonl' } },
  STORES['kimi.session-dir'],
] as const satisfies readonly NativeSessionStore[]

export const EVIDENCE = {
  'claude-code.projects-jsonl': { servedModel: 'provider-response', usage: 'per-response', endingError: 'session-record' },
  'codex.rollout-jsonl': { servedModel: 'turn-context', usage: 'cumulative', endingError: 'session-record' },
  'opencode.sqlite': { servedModel: 'turn-context', usage: 'per-response', endingError: 'session-record' },
  'pi.session-jsonl': { servedModel: 'session-record', usage: 'per-response', endingError: 'session-record' },
  'kimi.session-dir': { servedModel: 'none', usage: 'per-response', endingError: 'session-record' },
  'factory.session-jsonl': { servedModel: 'turn-context', usage: 'session-total', endingError: 'none' },
  'gemini.chat-json': { servedModel: 'session-record', usage: 'per-response', endingError: 'none' },
  'amp.thread-json': { servedModel: 'session-record', usage: 'per-response', endingError: 'none' },
  'forge.sqlite': { servedModel: 'session-record', usage: 'per-response', endingError: 'none' },
  'hermes.state-sqlite': { servedModel: 'session-record', usage: 'session-total', endingError: 'none' },
  'prime.session-jsonl': { servedModel: 'session-record', usage: 'per-response', endingError: 'session-record' },
  'openclaw.session-jsonl': { servedModel: 'session-record', usage: 'per-response', endingError: 'none' },
  'grok.acp-session-dir': { servedModel: 'session-record', usage: 'session-total', endingError: 'none' },
} as const satisfies Record<SessionFormatId, SessionEvidenceSources>

/** Codex homes: `.codex`, `.codex-*`, acct homes, and a fleet seat's `codex` directory. */
export const CODEX_HOME_RULE = {
  /** Directory names directly under HOME that are Codex homes: `.codex` and `.codex-<name>`. */
  siblings: /^\.codex(?:-.+)?$/u,
  /** Under HOME, unless `$ACCT_CONFIG` names it: each child is one account's Codex home. */
  accounts: '.config/agent-accounts/codex',
  sessionDirs: ['sessions', 'archived_sessions'],
  /** A rollout's file name, at any depth under a session dir (`sessions/` nests by date). */
  rollout: 'rollout-*.jsonl',
  /** The name Codex gives a rollout, ending in its thread id. */
  named: 'rollout-*-{id}.jsonl',
} as const

/**
 * True when `dir` is itself a Codex home by its path: `.codex`, `.codex-<name>`, an acct account
 * home (`agent-accounts/codex/<account>`), or a fleet seat's `codex` directory.
 */
export function isCodexHome(dir: string): boolean {
  const parts = dir.replace(/\/+$/u, '').split('/')
  const [name, parent, grandparent] = [parts.at(-1) ?? '', parts.at(-2) ?? '', parts.at(-3) ?? '']
  if (CODEX_HOME_RULE.siblings.test(name)) return true
  if (grandparent === 'agent-accounts' && parent === 'codex') return true
  return name === 'codex' && parent !== 'agent-accounts'
}

/** True when `path` is `root` or lies under it on a path boundary: `/x/agent` is not under `/x/age`. */
export function withinPath(path: string, root: string): boolean {
  const p = path.replace(/\/+$/u, '')
  const r = root.replace(/\/+$/u, '')
  return p === r || p.startsWith(`${r}/`)
}

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

/** A store root must be a normalized path relative to HOME: not absolute, no `.`/`..` segments. */
export function assertStoreRoot(root: string): void {
  const segments = root.split('/')
  if (root.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`store root must be a normalized path relative to HOME: ${root}`)
  }
}
