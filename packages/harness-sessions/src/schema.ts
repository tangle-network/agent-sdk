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
  kind: string
  message: string
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
  modelCallId: string | null
  parts: Part[]
}

export interface SessionToolCall {
  id: string
  name: string
  input: unknown
  inputText: string | null
  result: {
    output: unknown
    text: string | null
    isError: boolean
    at: string | null
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
  servedModel: string | null
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
  unparsedRecords: number
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
  servedModels: Record<string, number>
  modelSource: SessionEvidenceSources['servedModel']
  usage: TokenUsage | null
  ending: SessionEnding
  children: Array<{ nativeSessionId: string; toolCallId: string | null }>
  integrity: SessionIntegrity
}

export interface SessionSummary {
  harness: string
  format: SessionFormatId
  nativeSessionId: string
  parentNativeSessionId: string | null
  modelCalls: number
  replies: number
  toolCalls: number
  servedModels: Record<string, number>
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

export interface SessionRef {
  harness: string
  format: SessionFormatId
  nativeSessionId: string
  path: string
  files: readonly string[]
  home: string | null
  cwd: string | null
  mtimeMs: number
  parentNativeSessionId: string | null
  truncated?: boolean
}

export interface LocateOptions {
  nativeSessionId?: string
  cwd?: string
  sinceMs?: number
}

export interface ReadOptions {
  signal?: AbortSignal
  corruption?: 'recover' | 'strict'
}

export interface HarnessSessionReader {
  harness: string
  aliases: readonly string[]
  formats: readonly SessionFormatId[]
  stores: readonly NativeSessionStore[]
  globs: { session: string; children?: string }
  evidence: SessionEvidenceSources
  locate(home: string, opts?: LocateOptions): Promise<SessionRef[]>
  read(ref: SessionRef, opts?: ReadOptions): Promise<HarnessSession>
  summarize(ref: SessionRef, opts?: Pick<ReadOptions, 'signal'>): Promise<SessionSummary>
}

export interface NativeSessionCopy {
  harness: string
  format: SessionFormatId
  executionId: string
  attempt: number
  nativeSessionId: string
  copy: 'snapshot' | 'settled'
  capturedAt: string
  process: { pid: number | null; exitedAt: string | null; exitCode: number | null; signal: string | null }
  files: Array<{
    path: string
    store: string
    storePath?: string
    sizeBytes: number
    sha256: string
    method: 'byte-prefix' | 'atomic-file' | 'sqlite-backup'
    truncated: boolean
  }>
  complete: boolean
  missingReasons: string[]
}

export interface RawEvidenceArchiveManifestV2 {
  schema: 'tangle.raw-evidence-archive.v2'
  nativeSessions: NativeSessionCopy[]
}

export const HARNESS_SESSION_SCHEMA = 'tangle.harness-session.v1' as const
