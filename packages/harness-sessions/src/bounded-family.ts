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
  /** Every native conversation observed for this execution, in execution order. */
  readonly nativeSessionIds?: readonly string[]
  readonly files: readonly HarnessFileBinding[]
  readonly read: (file: HarnessFileBinding, signal?: AbortSignal) => Promise<Uint8Array>
  readonly signal?: AbortSignal
  /** Host-owned relative-path policy, applied before any read. */
  readonly validatePath: (path: string, signal?: AbortSignal) => void | Promise<void>
  /** Compatibility error identity remains with the execution owner. */
  readonly failure?: (message: string) => Error
} & (
  | { readonly parse: (text: string, file: HarnessFileBinding) => S | Promise<S>; readonly parseBytes?: never }
  | { readonly parse?: never; readonly parseBytes: (bytes: Uint8Array, file: HarnessFileBinding, signal?: AbortSignal) => S | Promise<S> }
)) {
  const files: { path: string; nativeSessionId: string; sha256: string; byteLength: number }[] = []
  const sessions = new Map<string, S>()
  const parents = new Map<string, string>()
  const paths = new Map<string, { bytes: Uint8Array; ids: Set<string> }>()
  const invalid = input.failure ?? ((message: string) => new Error(message))
  if ((typeof input.parse === 'function') === (typeof input.parseBytes === 'function'))
    throw invalid('Native capture requires exactly one parser')
  const roots = input.nativeSessionIds ?? [input.nativeSessionId]
  if (
    !roots.length || roots.length > BOUND_HARNESS_SESSION_READ_LIMITS.maxFiles ||
    roots.some(id => !id) || new Set(roots).size !== roots.length ||
    !roots.includes(input.nativeSessionId)
  ) throw invalid('Native capture has ambiguous root session identities')
  const pending = [...roots]
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
      await input.validatePath(file.path, input.signal)
      input.signal?.throwIfAborted()
      const held = paths.get(file.path)
      if (HARNESS_TRANSCRIPT_DENY.test(file.path) || (held && (!input.parseBytes || held.ids.has(id))))
        throw invalid('Native file path is denied or repeated')
      // A binary store can bind several sessions to the same immutable bytes. Read it once;
      // each session still has its own digest, identity and parentage checks below.
      const bytes = held?.bytes ?? Uint8Array.from(await input.read(file, input.signal))
      input.signal?.throwIfAborted()
      if (!held) total += bytes.byteLength
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
      const session = input.parseBytes
        ? await input.parseBytes(Uint8Array.from(bytes), file, input.signal)
        : await input.parse!(new TextDecoder('utf-8', { fatal: true }).decode(bytes), file)
      input.signal?.throwIfAborted()
      if (held) held.ids.add(id)
      else paths.set(file.path, { bytes, ids: new Set([id]) })
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
      const recordedChild = sessions.get(child.nativeSessionId)
      if (recordedChild?.parentNativeSessionId && recordedChild.parentNativeSessionId !== id)
        throw invalid('Native child has a different recorded parent')
      let ancestor: string | undefined = id
      while (ancestor !== undefined) {
        if (ancestor === child.nativeSessionId)
          throw invalid('Native child has a cyclic recorded parent')
        ancestor = parents.get(ancestor)
      }
      parents.set(child.nativeSessionId, id)
      if (!sessions.has(child.nativeSessionId)) pending.push(child.nativeSessionId)
    }
  }
  return { files, sessions: [...sessions.values()] }
}
