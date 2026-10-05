/**
 * The catalog of native session stores: where each harness format lives under the HOME it ran
 * with, how it is written, and where its served model, usage and ending error come from.
 *
 * Pure data and pure functions with no Node built-ins, so Worker-safe code (the sidecar's harness
 * registry) imports the same declarations the readers use: `@tangle-network/harness-sessions/catalog`.
 */
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
] as const satisfies readonly SessionFormatId[]

/** Store layouts, relative to the HOME a harness ran with. */
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
  // A session directory: wire.jsonl (the event stream read here), context.jsonl and its rotated
  // context_N.jsonl copies, and state.json.
  'kimi.session-dir': {
    root: '.kimi/sessions',
    files: ['*/{id}/**', '*/{id}.jsonl'],
    write: 'jsonl-append',
    shared: false,
    format: 'kimi.session-dir',
  },
  'factory.session-jsonl': {
    root: '.factory/sessions',
    files: ['*/{id}.jsonl', '*/{id}.settings.json'],
    write: 'jsonl-append',
    shared: false,
    format: 'factory.session-jsonl',
  },
  'gemini.chat-json': {
    root: '.gemini/tmp',
    files: ['*/chats/session-*{id}*.json'],
    write: 'json-rewrite',
    shared: false,
    format: 'gemini.chat-json',
  },
  'amp.thread-json': {
    root: '.local/share/amp/threads',
    files: ['{id}.json'],
    write: 'json-rewrite',
    shared: false,
    format: 'amp.thread-json',
  },
  'forge.sqlite': {
    root: '.forge',
    files: ['.forge.db', '.forge.db-wal', '.forge.db-shm'],
    write: 'sqlite-wal',
    shared: true,
    format: 'forge.sqlite',
  },
  'hermes.state-sqlite': {
    root: '.hermes',
    files: ['state.db', 'state.db-wal', 'state.db-shm'],
    write: 'sqlite-wal',
    shared: true,
    format: 'hermes.state-sqlite',
  },
  'prime.session-jsonl': {
    root: '.prime-provider/prime-agent-dirs',
    files: ['**/*_{id}.jsonl'],
    write: 'jsonl-append',
    shared: false,
    format: 'prime.session-jsonl',
  },
  'openclaw.session-jsonl': {
    root: '.openclaw/agents',
    files: ['**/{id}.jsonl'],
    write: 'jsonl-append',
    shared: false,
    format: 'openclaw.session-jsonl',
  },
} as const satisfies Record<SessionFormatId, NativeSessionStore>

/**
 * Where each format's served model, usage and ending error come from. `turn-context` means the
 * model the harness was configured or asked for (Codex `turn_context`, OpenCode's message
 * `modelID`, Factory's settings); `none` means the session records no model at all.
 */
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
} as const satisfies Record<SessionFormatId, SessionEvidenceSources>

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
