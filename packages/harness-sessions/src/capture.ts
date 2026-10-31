import { isRecord } from '@tangle-network/agent-core'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { str } from './builder.js'
import { opencodeSessionsInStore } from './formats/opencode.js'
import { hermesSessionsInStore } from './formats/hermes.js'
import { openclawSessionsInStore } from './formats/openclaw.js'
import { maybeReaderFor, readerFor, readerForFormat } from './registry.js'
import type { HarnessSession, HarnessSessionReader, NativeSessionCopy, RawEvidenceArchiveManifestV2, SessionRef } from './schema.js'
import { isMissing } from './source.js'
import { storeGlob } from './stores.js'

export const RETENTION_SESSIONS = join('__retention__', 'sessions')
export const RETENTION_MANIFEST_KIND = 'tangle-native-session-evidence.v1'

export interface CapturedSessionRef {
  ref: SessionRef
  harness: string
  sandboxSessionId: string | null
  executionId: string | null
  attempt: number | null
  copy: NativeSessionCopy['copy'] | 'retained'
  recordedId: boolean
  root: string
  sourceId: string | null
  rootScope: string | null
}

export interface CaptureListing {
  sessions: CapturedSessionRef[]
  missing: Array<{
    sandboxSessionId: string | null
    harness: string | null
    reason: string
    nativeSessionId?: string
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

async function fromV2(archiveDir: string, manifest: RawEvidenceArchiveManifestV2, listing: CaptureListing): Promise<void> {
  for (const copy of manifest.nativeSessions) {
    const reader = maybeReaderFor(copy.harness) ?? readerForFormatSafe(copy.format)
    if (!reader) {
      listing.missing.push({ sandboxSessionId: null, harness: copy.harness, reason: 'no_reader_for_harness', nativeSessionId: copy.nativeSessionId })
      continue
    }
    const stores = reader.stores.filter((s) => s.format === copy.format)
    const store = stores.find((s) => copy.files.some((f) => storePathOf(f).includes(`${s.root}/`))) ?? stores[0] ?? reader.stores[0]!
    const inStore = (path: string): string | null => {
      const marker = `${store.root}/`
      const index = path.indexOf(marker)
      return index === -1 ? null : path.slice(index + marker.length)
    }
    const truncated = copy.files.some((f) => f.truncated)
    if (store.shared) {
      const db = copy.files.find((f) => inStore(storePathOf(f)) === store.files[0])
      if (!db) {
        listing.missing.push({ sandboxSessionId: null, harness: copy.harness, reason: 'store_file_missing', nativeSessionId: copy.nativeSessionId })
        continue
      }
      const path = join(archiveDir, db.path)
      const refs = store.format === 'hermes.state-sqlite' ? await hermesSessionsInStore(path) : store.format === 'openclaw.session-jsonl' ? await openclawSessionsInStore(path) : await opencodeSessionsInStore(path, null, {})
      const children = new Map<string, string[]>()
      for (const ref of refs) if (ref.parentNativeSessionId) {
        const group = children.get(ref.parentNativeSessionId) ?? []
        group.push(ref.nativeSessionId); children.set(ref.parentNativeSessionId, group)
      }
      const ids = new Set([copy.nativeSessionId])
      for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child)
      for (const ref of refs.filter((r) => ids.has(r.nativeSessionId))) {
        listing.sessions.push(captured({ ...ref, truncated }, copy, ref.nativeSessionId === copy.nativeSessionId, archiveDir, path))
      }
      if (!refs.some((r) => r.nativeSessionId === copy.nativeSessionId)) {
        listing.missing.push({ sandboxSessionId: null, harness: copy.harness, reason: 'native_session_not_in_store', nativeSessionId: copy.nativeSessionId })
      }
      continue
    }
    const globs = store.globs ?? reader.globs
    const main = storeGlob(globs.session, copy.nativeSessionId)
    const nested = globs.children ? [storeGlob(globs.children, copy.nativeSessionId)] : []
    const mainFile = copy.files.find((f) => { const rel = inStore(storePathOf(f)); return rel !== null && main.test(rel) })
    if (!mainFile) {
      listing.missing.push({ sandboxSessionId: null, harness: copy.harness, reason: 'native_session_file_missing', nativeSessionId: copy.nativeSessionId })
      continue
    }
    const mainPath = join(archiveDir, mainFile.path)
    const nestedFiles = copy.files.filter((f) => { const rel = inStore(storePathOf(f)); return rel !== null && nested.some((n) => n.test(rel)) }).map((f) => join(archiveDir, f.path))
    const declared = store.files.map((pattern) => storeGlob(pattern, copy.nativeSessionId))
    const files = [...new Set([mainPath, ...nestedFiles, ...copy.files.filter((f) => { const rel = inStore(storePathOf(f)); return rel !== null && declared.some((pattern) => pattern.test(rel)) }).map((f) => join(archiveDir, f.path))])]
    listing.sessions.push(captured({ harness: reader.harness, format: store.format, nativeSessionId: copy.nativeSessionId, path: mainPath, files, home: null, cwd: null, mtimeMs: Date.parse(copy.capturedAt) || 0, parentNativeSessionId: null, truncated: mainFile.truncated }, copy, true, archiveDir, mainPath))
    for (const file of nestedFiles) {
      const child = file.split('/').pop()!.replace(/\.jsonl$/u, '').replace(/^agent-/u, '')
      listing.sessions.push(captured({ harness: reader.harness, format: store.format, nativeSessionId: child, path: file, files: [file], home: null, cwd: null, mtimeMs: Date.parse(copy.capturedAt) || 0, parentNativeSessionId: copy.nativeSessionId, truncated }, copy, false, archiveDir, file))
    }
  }
}

function storePathOf(file: NativeSessionCopy['files'][number]): string {
  return file.storePath ?? file.path
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
    for (const sourceId of await dirs(join(dir, 'native'))) {
      for (const rootScope of await dirs(join(dir, 'native', sourceId))) {
        const home = join(dir, 'native', sourceId, rootScope)
        let refs: SessionRef[]
        try {
          refs = await reader.locate(home)
        } catch (error) {
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

export async function* readCapture(
  dir: string,
  manifest?: RawEvidenceArchiveManifestV2 | null,
  options: { harness?: string } = {},
): AsyncIterable<HarnessSession> {
  const listing = await listCapture(dir, manifest, options)
  for (const session of listing.sessions) yield await readerFor(session.harness).read(session.ref)
}
