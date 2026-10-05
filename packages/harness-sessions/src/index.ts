/**
 * `@tangle-network/harness-sessions` — one reader for every coding-agent harness's native session.
 *
 * Every harness persists its session in its own store (Claude Code and Pi append JSONL, Codex
 * appends a rollout, OpenCode writes SQLite). This package declares each store's layout once and
 * parses each format into one normalized {@link HarnessSession}: messages, tool calls with their
 * inputs and results, the model calls with the model that served them, usage and the error a
 * session ended with. The sidecar's capture contract, the Discovery gate, agent-eval,
 * agent-record and the blog read sessions only through it.
 */
export type {
  HarnessSession,
  HarnessSessionReader,
  LocateOptions,
  ModelCall,
  NativeSessionCopy,
  NativeSessionStore,
  Part,
  RawEvidenceArchiveManifestV2,
  ReadOptions,
  SessionEnding,
  SessionError,
  SessionEvidenceSources,
  SessionFormatId,
  SessionIntegrity,
  SessionMessage,
  SessionRef,
  SessionSummary,
  SessionToolCall,
  TokenUsage,
} from './schema.js'
export { HARNESS_SESSION_SCHEMA } from './schema.js'
export { EVIDENCE, STORES, assertStoreRoot, storeGlob } from './stores.js'
export { knownHarnesses, listReaders, maybeReaderFor, readerFor, readerForFormat } from './registry.js'
export { claudeCodeReader, claudeCodeRefForFile } from './formats/claude-code.js'
export { codexReader, codexRefForFile } from './formats/codex.js'
export { opencodeReader, opencodeSessionsInStore } from './formats/opencode.js'
export { piReader, piRefForFile } from './formats/pi.js'
export { kimiReader, kimiRefForFile } from './formats/kimi.js'
export { FACTORY_SETTINGS_STORE, factoryReader, factoryRefForFile } from './formats/factory.js'
export {
  listCapture,
  readCapture,
  RETENTION_MANIFEST_KIND,
  RETENTION_SESSIONS,
  type CaptureListing,
  type CapturedSessionRef,
} from './capture.js'
export { SessionParseError } from './source.js'
export { servedModelKey } from './builder.js'
export { toChatMessages, type ChatMessage, type ChatProjectionOptions, type ChatToolCall } from './projections/chat.js'
export { primaryModel, summarizeText, toTurns, type Turn, type TurnOptions, type TurnToolCall } from './projections/turns.js'
export { toOtlpSpans, type OtlpProjectionOptions } from './projections/otlp.js'
export { readSessionInput, summarizeSessionInput, type SessionInput, type SessionInputInit } from './input.js'
