/** One native session format. The id names the harness family and the on-disk layout. */
export type SessionFormatId = (typeof import('./catalog.js').SESSION_FORMAT_IDS)[number]

export interface NativeSessionStore {
  root: string
  files: readonly string[]
  write: 'jsonl-append' | 'json-rewrite' | 'sqlite-wal'
  shared: boolean
  format: SessionFormatId
  globs?: { session: string; children?: string }
}

export interface SessionEvidenceSources {
  servedModel: 'provider-response' | 'session-record' | 'turn-context' | 'none'
  usage: 'per-response' | 'cumulative' | 'session-total'
  endingError: 'session-record' | 'none'
}

export interface TokenUsage {
  input: number | null
  output: number | null
  reasoning: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export interface SessionError {
  /** The harness's own classification: `api-error`, `stream_error`, a provider error name. */
  kind: string
  message: string
  /** The provider's HTTP status when the harness recorded it. */
  httpStatus: number | null
  at: string | null
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; redacted: boolean }
  | { type: 'tool-call'; toolCallId: string }
  | { type: 'tool-result'; toolCallId: string }
  | { type: 'attachment'; mediaType: string; ref: string }

export interface SessionMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  actor: 'human' | 'agent' | 'subagent-spawn' | 'injected' | 'tool-result'
  at: string | null
  /** The model call that produced an assistant message; null for every other message. */
  modelCallId: string | null
  parts: Part[]
}

export interface SessionToolCall {
  id: string
  name: string
  /** The arguments as structured data when the harness recorded JSON, otherwise the raw text. */
  input: unknown
  /** The arguments exactly as the harness recorded them when it recorded text. */
  inputText: string | null
  result: {
    output: unknown
    text: string | null
    isError: boolean
    at: string | null
    /** The harness's own structured result (Claude Code `toolUseResult`, Pi `details`, OpenCode `metadata`). */
    details: unknown
  } | null
  status: 'completed' | 'error' | 'pending' | 'interrupted'
  startedAt: string | null
  endedAt: string | null
  messageId: string
}

export interface ModelCall {
  id: string
  at: string | null
  provider: string | null
  /** The model that answered, from the provider response or the session record. Never the request. */
  servedModel: string | null
  /**
   * The model the harness sent the request to, when the session records it. A failed request has
   * no served model; this says which model it was meant for. Never counted as served.
   */
  requestedModel: string | null
  usage: TokenUsage | null
  costUsd: number | null
  stopReason: string | null
  error: SessionError | null
}

export interface SessionEnding {
  status: 'completed' | 'error' | 'aborted' | 'open'
  error: SessionError | null
  at: string | null
}

export interface SessionIntegrity {
  sourceFiles: Array<{ path: string; sha256: string; bytes: number }>
  /** Records the reader could not parse. Never fatal in recover mode. */
  unparsedRecords: number
  /** True when a source copy was cut short (a bounded capture kept only a prefix). */
  truncated: boolean
  gaps: string[]
}

export interface HarnessSession {
  schema: 'tangle.harness-session.v1'
  harness: string
  format: SessionFormatId
  nativeSessionId: string
  parentNativeSessionId: string | null
  cwd: string | null
  startedAt: string | null
  endedAt: string | null
  messages: SessionMessage[]
  toolCalls: SessionToolCall[]
  modelCalls: ModelCall[]
  /** `provider/model` (or the bare model when no provider is recorded) -> calls it answered. */
  servedModels: Record<string, number>
  modelSource: SessionEvidenceSources['servedModel']
  /** Null when the harness recorded no usage at all. Never reported as zero. */
  usage: TokenUsage | null
  ending: SessionEnding
  children: Array<{ nativeSessionId: string; toolCallId: string | null }>
  integrity: SessionIntegrity
}

/** What `summarize` keeps: counts and the facts a gate needs, in constant memory. */
export interface SessionSummary {
  harness: string
  format: SessionFormatId
  nativeSessionId: string
  parentNativeSessionId: string | null
  modelCalls: number
  /** Assistant messages the agent produced. */
  replies: number
  toolCalls: number
  servedModels: Record<string, number>
  /** The served-model key (`provider/model`) of the last model call that a model answered. */
  lastServedModel: string | null
  modelSource: HarnessSession['modelSource']
  usage: TokenUsage | null
  ending: SessionEnding
  unparsedRecords: number
  bytes: number
  truncated: boolean
  startedAt: string | null
  endedAt: string | null
}

/** One discovered session, before it is read. */
export interface SessionRef {
  harness: string
  format: SessionFormatId
  nativeSessionId: string
  /** The session's primary file (the JSONL, or the SQLite store for a shared store). */
  path: string
  /** Every file whose bytes the read depends on, including subagent files and SQLite siblings. */
  files: readonly string[]
  /** The HOME the session was found under, when it was located through a store. */
  home: string | null
  cwd: string | null
  mtimeMs: number
  parentNativeSessionId: string | null
  /** True when the copy this ref points at is a bounded prefix of the session. */
  truncated?: boolean
}

export interface LocateOptions {
  nativeSessionId?: string
  /** Sessions whose recorded cwd is this path or lies under it on a path boundary (`/x/agent` excludes `/x/agent-dev-container`). */
  cwd?: string
  /** Sessions modified at or after this epoch ms. */
  sinceMs?: number
}

export interface ReadOptions {
  signal?: AbortSignal
  /** `recover` (default) counts unparsable records; `strict` throws on the first one. */
  corruption?: 'recover' | 'strict'
}

export interface HarnessSessionReader {
  harness: string
  aliases: readonly string[]
  formats: readonly SessionFormatId[]
  stores: readonly NativeSessionStore[]
  /**
   * Default globs under each store's root, unless that store supplies its own globs: the session
   * file and, when the harness writes subagent transcripts separately, those files.
   */
  globs: { session: string; children?: string }
  evidence: SessionEvidenceSources
  locate(home: string, opts?: LocateOptions): Promise<SessionRef[]>
  read(ref: SessionRef, opts?: ReadOptions): Promise<HarnessSession>
  /** Streams the session in constant memory with respect to message and tool-output size. */
  summarize(ref: SessionRef, opts?: Pick<ReadOptions, 'signal'>): Promise<SessionSummary>
}

/** One copy of a native session that the sidecar captured for an execution. */
export interface NativeSessionCopy {
  harness: string
  format: SessionFormatId
  executionId: string
  attempt: number
  nativeSessionId: string
  /** `snapshot`: taken while the harness ran. `settled`: taken after it exited, however it ended. */
  copy: 'snapshot' | 'settled'
  capturedAt: string
  /** Null where the sidecar did not observe the value at the copy point. */
  process: { pid: number | null; exitedAt: string | null; exitCode: number | null; signal: string | null }
  files: Array<{
    /** Path inside the archive, relative to the archive root. */
    path: string
    /** The store root the file belongs to, relative to the runtime HOME. */
    store: string
    /** The file's own path relative to the runtime HOME; the sidecar archive's payload names are flat. */
    storePath?: string
    sizeBytes: number
    sha256: string
    method: 'byte-prefix' | 'atomic-file' | 'sqlite-backup'
    truncated: boolean
  }>
  complete: boolean
  missingReasons: string[]
}

/** The part of the sidecar's raw-evidence archive manifest this package reads. */
export interface RawEvidenceArchiveManifestV2 {
  schema: 'tangle.raw-evidence-archive.v2'
  nativeSessions: NativeSessionCopy[]
}

export const HARNESS_SESSION_SCHEMA = 'tangle.harness-session.v1' as const
