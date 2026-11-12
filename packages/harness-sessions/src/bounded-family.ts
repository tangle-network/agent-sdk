import { sha256Hex } from '@tangle-network/agent-core/node'

/** One native-family read bound shared by producers and retained readers. */
export const BOUND_HARNESS_SESSION_READ_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxFiles: 1_000,
})

/** Credential-shaped paths are refused even when a producer lists them. */
export const HARNESS_TRANSCRIPT_DENY =
  /(^|\/)(auth\.json|\.credentials\.json|credentials|\.netrc|\.env(\..*)?|secrets?(\.|$)|.*\.(pem|key|p12|pfx)|id_[a-z0-9_]+)$/iu

export interface BoundHarnessSession {
  readonly nativeSessionId: string
  readonly parentNativeSessionId?: string | null
  readonly children: readonly { readonly nativeSessionId: string }[]
  readonly integrity: {
    readonly truncated: boolean
    readonly unparsedRecords: number
    readonly gaps: readonly unknown[]
  }
}
export interface HarnessFileBinding {
  readonly path: string
  readonly nativeSessionId: string
  readonly sha256?: string
  readonly byteLength?: number
}

/** Verify a bound native family without owning a store, filesystem layout or native parser. */
export async function readBoundHarnessSessions<S extends BoundHarnessSession>(input: {
  readonly nativeSessionId: string
  readonly files: readonly HarnessFileBinding[]
  readonly read: (file: HarnessFileBinding, signal?: AbortSignal) => Promise<Uint8Array>
  readonly parse: (text: string, file: HarnessFileBinding) => S
  readonly signal?: AbortSignal
  /** Host-owned relative-path policy, applied before any read. */
  readonly validatePath: (path: string) => void
  /** Compatibility error identity remains with the execution owner. */
  readonly failure?: (message: string) => Error
}) {
  const files: { path: string; nativeSessionId: string; sha256: string; byteLength: number }[] = []
  const sessions = new Map<string, S>()
  const parents = new Map<string, string>()
  const paths = new Set<string>()
  const invalid = input.failure ?? ((message: string) => new Error(message))
  const pending = [input.nativeSessionId]
  let total = 0
  while (pending.length) {
    const id = pending.shift()!
    if (sessions.has(id)) continue
    const candidates = input.files.filter((file) => file.nativeSessionId === id)
    if (!candidates.length)
      throw invalid('The exact native session or a recorded child was not retained')
    for (const file of candidates) {
      input.signal?.throwIfAborted()
      if (files.length >= BOUND_HARNESS_SESSION_READ_LIMITS.maxFiles)
        throw invalid('Native file count exceeds the capture bound')
      input.validatePath(file.path)
      if (HARNESS_TRANSCRIPT_DENY.test(file.path) || paths.has(file.path))
        throw invalid('Native file path is denied or repeated')
      paths.add(file.path)
      const bytes = await input.read(file, input.signal)
      input.signal?.throwIfAborted()
      total += bytes.byteLength
      if (
        bytes.byteLength > BOUND_HARNESS_SESSION_READ_LIMITS.maxFileBytes ||
        total > BOUND_HARNESS_SESSION_READ_LIMITS.maxTotalBytes
      )
        throw invalid('Native bytes exceed the capture bound')
      const actual = `sha256:${sha256Hex(bytes)}`
      if (
        (file.sha256 && file.sha256.replace(/^sha256:/, '') !== actual.slice(7)) ||
        (file.byteLength !== undefined && file.byteLength !== bytes.byteLength)
      )
        throw invalid('Captured native session bytes changed')
      const session = input.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), file)
      if (
        session.nativeSessionId !== id ||
        session.integrity.truncated ||
        session.integrity.unparsedRecords ||
        session.integrity.gaps.length
      )
        throw invalid('Native session identity or integrity did not match its binding')
      if (
        session.parentNativeSessionId &&
        parents.has(id) &&
        session.parentNativeSessionId !== parents.get(id)
      )
        throw invalid('Native child has a different recorded parent')
      const prior = files.find((value) => value.nativeSessionId === id)
      if (prior && prior.sha256 !== actual)
        throw invalid('Native session copies are ambiguous')
      files.push({
        path: file.path,
        nativeSessionId: id,
        sha256: actual,
        byteLength: bytes.byteLength,
      })
      if (!prior) sessions.set(id, session)
    }
    for (const child of sessions.get(id)!.children) {
      if (parents.has(child.nativeSessionId) && parents.get(child.nativeSessionId) !== id)
        throw invalid('Native child has ambiguous recorded parents')
      parents.set(child.nativeSessionId, id)
      if (!sessions.has(child.nativeSessionId)) pending.push(child.nativeSessionId)
    }
  }
  return { files, sessions: [...sessions.values()] }
}
