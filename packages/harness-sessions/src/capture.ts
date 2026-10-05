/**
 * Reading the native sessions in a capture.
 *
 * The sidecar's raw-evidence archive v2 lists each execution's native session copies in
 * `nativeSessions[]`, with the harness, the session id recorded at spawn, the copy kind and the
 * files. A capture taken before v2 (provider-tangle's retention layout, `tangle-native-session-
 * evidence.v1`) has no such list: it holds each execution's private runtime HOME under
 * `__retention__/sessions/<sandbox session>/native/<source>/<root scope>/`, and its manifest names
 * the harness and, once an attempt settled, the native session ids. Both are read through the
 * store layouts the readers declare; no consumer matches session paths itself.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord, str } from './builder.js'
import { opencodeSessionsInStore } from './formats/opencode.js'
import { maybeReaderFor, readerFor, readerForFormat } from './registry.js'
import type { HarnessSession, HarnessSessionReader, NativeSessionCopy, RawEvidenceArchiveManifestV2, SessionRef } from './schema.js'
import { isMissing } from './source.js'
import { storeGlob } from './stores.js'

export const RETENTION_SESSIONS = join('__retention__', 'sessions')
export const RETENTION_MANIFEST_KIND = 'tangle-native-session-evidence.v1'

/** One native session found in a capture, with the ids that join it to its execution. */
export interface CapturedSessionRef {
  ref: SessionRef
  harness: string
  /** The sandbox (provider) session the capture belongs to. */
  sandboxSessionId: string | null
  executionId: string | null
  attempt: number | null
  copy: NativeSessionCopy['copy'] | 'retained'
  /** True when the sidecar recorded this native session id for the execution. */
  recordedId: boolean
  /** The capture's native root the session was found in, relative to the capture directory. */
  root: string
  sourceId: string | null
  rootScope: string | null
}

export interface CaptureListing {
  sessions: CapturedSessionRef[]
  /** Executions whose harness has no reader, and ids recorded but not found in the copy. */
  missing: Array<{
    sandboxSessionId: string | null
    harness: string | null
    reason: string
    nativeSessionId?: string
    /** The capture root (relative to the capture directory) and store file a reason refers to. */
    root?: string
    path?: string
    detail?: string
  }>
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

/** Sessions listed by a v2 archive manifest. Files are resolved against `archiveDir`. */
async function fromV2(archiveDir: string, manifest: RawEvidenceArchiveManifestV2, listing: CaptureListing): Promise<void> {
  for (const copy of manifest.nativeSessions) {
    const reader = maybeReaderFor(copy.harness) ?? readerForFormatSafe(copy.format)
    if (!reader) {
      listing.missing.push({ sandboxSessionId: null, harness: copy.harness, reason: 'no_reader_for_harness', nativeSessionId: copy.nativeSessionId })
      continue
    }
    const store = reader.stores.find((s) => s.format === copy.format) ?? reader.stores[0]!
    const inStore = (path: string): string | null => {
      const marker = `${store.root}/`
      const index = path.indexOf(marker)
      return index === -1 ? null : path.slice(index + marker.length)
    }
    const truncated = copy.files.some((f) => f.truncated)
    if (store.shared) {
      const db = copy.files.find((f) => inStore(f.path) === store.files[0])
      if (!db) {
        listing.missing.push({ sandboxSessionId: null, harness: copy.harness, reason: 'store_file_missing', nativeSessionId: copy.nativeSessionId })
        continue
      }
      const path = join(archiveDir, db.path)
      const refs = await opencodeSessionsInStore(path, null, {})
      const ids = new Set([copy.nativeSessionId])
      // Child sessions of the execution's session live in the same store.
      for (const ref of refs) if (ref.parentNativeSessionId && ids.has(ref.parentNativeSessionId)) ids.add(ref.nativeSessionId)
      for (const ref of refs.filter((r) => ids.has(r.nativeSessionId))) {
        listing.sessions.push(captured({ ...ref, truncated }, copy, ref.nativeSessionId === copy.nativeSessionId, archiveDir, path))
      }
      if (!refs.some((r) => r.nativeSessionId === copy.nativeSessionId)) {
        listing.missing.push({ sandboxSessionId: null, harness: copy.harness, reason: 'native_session_not_in_store', nativeSessionId: copy.nativeSessionId })
      }
      continue
    }
    const main = storeGlob(reader.globs.session, copy.nativeSessionId)
    const nested = reader.globs.children ? [storeGlob(reader.globs.children, copy.nativeSessionId)] : []
    const mainFile = copy.files.find((f) => { const rel = inStore(f.path); return rel !== null && main.test(rel) })
    if (!mainFile) {
      listing.missing.push({ sandboxSessionId: null, harness: copy.harness, reason: 'native_session_file_missing', nativeSessionId: copy.nativeSessionId })
      continue
    }
    const mainPath = join(archiveDir, mainFile.path)
    const nestedFiles = copy.files.filter((f) => { const rel = inStore(f.path); return rel !== null && nested.some((n) => n.test(rel)) }).map((f) => join(archiveDir, f.path))
    listing.sessions.push(captured({ harness: reader.harness, format: store.format, nativeSessionId: copy.nativeSessionId, path: mainPath, files: [mainPath, ...nestedFiles], home: null, cwd: null, mtimeMs: Date.parse(copy.capturedAt) || 0, parentNativeSessionId: null, truncated: mainFile.truncated }, copy, true, archiveDir, mainPath))
    for (const file of nestedFiles) {
      const child = file.split('/').pop()!.replace(/\.jsonl$/u, '').replace(/^agent-/u, '')
      listing.sessions.push(captured({ harness: reader.harness, format: store.format, nativeSessionId: child, path: file, files: [file], home: null, cwd: null, mtimeMs: Date.parse(copy.capturedAt) || 0, parentNativeSessionId: copy.nativeSessionId, truncated }, copy, false, archiveDir, file))
    }
  }
}

function readerForFormatSafe(format: NativeSessionCopy['format']): HarnessSessionReader | undefined {
  try {
    return readerForFormat(format)
  } catch {
    return undefined
  }
}

function captured(ref: SessionRef, copy: NativeSessionCopy, recordedId: boolean, archiveDir: string, path: string): CapturedSessionRef {
  return {
    ref,
    harness: ref.harness,
    sandboxSessionId: null,
    executionId: copy.executionId,
    attempt: copy.attempt,
    copy: copy.copy,
    recordedId,
    root: path.startsWith(archiveDir) ? path.slice(archiveDir.length + 1) : path,
    sourceId: null,
    rootScope: null,
  }
}

/** Sessions in provider-tangle's retention layout, found through each reader's declared stores. */
async function fromRetention(captureDir: string, listing: CaptureListing, fallbackHarness: string | null): Promise<void> {
  const sessionsDir = join(captureDir, RETENTION_SESSIONS)
  for (const sandboxSessionId of await dirs(sessionsDir)) {
    const dir = join(sessionsDir, sandboxSessionId)
    const manifest = await readJson(join(dir, 'raw-manifest.json'))
    const source = isRecord(manifest) && isRecord(manifest.source) ? manifest.source : null
    if (isRecord(manifest) && Array.isArray((manifest as Record<string, unknown>).nativeSessions)) {
      await fromV2(dir, manifest as unknown as RawEvidenceArchiveManifestV2, listing)
      continue
    }
    // The manifest names the harness; a capture whose manifest does not falls back to the
    // harness the caller ran (the profile's), never to guessing from paths.
    const harness = (source ? str(source.backendType) : null) ?? fallbackHarness
    const reader = harness ? maybeReaderFor(harness) : undefined
    if (!reader) {
      listing.missing.push({ sandboxSessionId, harness, reason: harness ? 'no_reader_for_harness' : 'harness_not_recorded' })
      continue
    }
    const attempts = source && Array.isArray(source.attempts) ? source.attempts.filter(isRecord) : []
    const recorded = new Map<string, { executionId: string | null; attempt: number | null }>()
    for (const attempt of attempts) {
      for (const id of Array.isArray(attempt.nativeSessionIds) ? attempt.nativeSessionIds : []) {
        if (typeof id === 'string') recorded.set(id, { executionId: str(attempt.executionId), attempt: typeof attempt.ordinal === 'number' ? attempt.ordinal : null })
      }
    }
    if (source && typeof source.nativeSessionId === 'string' && !recorded.has(source.nativeSessionId)) {
      recorded.set(source.nativeSessionId, { executionId: null, attempt: null })
    }
    const lastAttempt = attempts[attempts.length - 1]
    const found = new Set<string>()
    // native/<source id>/<root scope>/ is one execution's runtime HOME (or its workspace).
    for (const sourceId of await dirs(join(dir, 'native'))) {
      for (const rootScope of await dirs(join(dir, 'native', sourceId))) {
        const home = join(dir, 'native', sourceId, rootScope)
        let refs: SessionRef[]
        try {
          refs = await reader.locate(home)
        } catch (error) {
          // A store that cannot be opened (a corrupt SQLite file) proves nothing about the turn.
          const store = reader.stores[0]!
          listing.missing.push({ sandboxSessionId, harness: reader.harness, reason: 'store_unreadable', root: home.slice(captureDir.length + 1), path: store.shared ? `${store.root}/${store.files[0]}` : store.root, detail: error instanceof Error ? error.message : String(error) })
          continue
        }
        for (const ref of refs) {
          const join_ = recorded.get(ref.nativeSessionId) ?? (ref.parentNativeSessionId ? recorded.get(ref.parentNativeSessionId) : undefined)
          found.add(ref.nativeSessionId)
          listing.sessions.push({
            ref,
            harness: reader.harness,
            sandboxSessionId,
            executionId: join_?.executionId ?? (lastAttempt ? str(lastAttempt.executionId) : null) ?? sourceId,
            attempt: join_?.attempt ?? (lastAttempt && typeof lastAttempt.ordinal === 'number' ? lastAttempt.ordinal : null),
            copy: 'retained',
            recordedId: recorded.has(ref.nativeSessionId),
            root: home.slice(captureDir.length + 1),
            sourceId,
            rootScope,
          })
        }
      }
    }
    for (const id of recorded.keys()) {
      if (!found.has(id)) listing.missing.push({ sandboxSessionId, harness: reader.harness, reason: 'native_session_not_in_copy', nativeSessionId: id })
    }
  }
}

/**
 * Every native session in a capture: from `manifest.nativeSessions` when a v2 manifest is given
 * (files relative to `dir`), otherwise from the retention layout under `dir`.
 */
export async function listCapture(
  dir: string,
  manifest?: RawEvidenceArchiveManifestV2 | null,
  options: { harness?: string } = {},
): Promise<CaptureListing> {
  const listing: CaptureListing = { sessions: [], missing: [] }
  if (manifest && Array.isArray(manifest.nativeSessions)) await fromV2(dir, manifest, listing)
  else await fromRetention(dir, listing, options.harness ?? null)
  return listing
}

/** Every native session in a capture, read in full. */
export async function* readCapture(
  dir: string,
  manifest?: RawEvidenceArchiveManifestV2 | null,
  options: { harness?: string } = {},
): AsyncIterable<HarnessSession> {
  const listing = await listCapture(dir, manifest, options)
  for (const session of listing.sessions) yield await readerFor(session.harness).read(session.ref)
}
