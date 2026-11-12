/** Descriptor-relative native-store inventory. The host owns the root handle and writer policy. */
import { constants, type Dirent } from 'node:fs'
import { open, readdir, type FileHandle } from 'node:fs/promises'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const inDirectory = (handle: FileHandle, name?: string): string => `/proc/self/fd/${handle.fd}${name === undefined ? '' : `/${name}`}`

export interface DeclaredSessionStore<Store> {
  store: Store
  /** Normalized, nonempty POSIX path relative to the opened HOME. */
  root: string
  matches(relative: string): boolean
}

export interface DeclaredSessionFile<Store> {
  store: Store
  /** Relative to the opened HOME. */
  path: string
  /** Caller closes every returned handle; no link was followed and the writer UID matched. */
  handle: FileHandle
}

async function openDirectoryPath(parent: FileHandle, relative: string): Promise<FileHandle | undefined> {
  let current = parent
  for (const name of relative.split('/')) {
    let next: FileHandle
    try { next = await open(inDirectory(current, name), DIRECTORY_FLAGS) }
    catch (error) {
      if (current !== parent) await current.close()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (current !== parent) await current.close()
    current = next
  }
  return current
}

/**
 * Linux descriptor-relative traversal extracted from the sidecar settled-copy path.
 * No ambient HOME discovery or path opening authority is inferred. The caller opens
 * and closes `home`, selects declarations and writer UID, and owns the entry ceiling.
 */
export async function locateDeclaredSessionFiles<Store>(input: {
  home: FileHandle
  stores: readonly DeclaredSessionStore<Store>[]
  uid: number
  maxEntries: number
  signal?: AbortSignal
}): Promise<{ files: DeclaredSessionFile<Store>[]; rejected: string[] }> {
  if (process.platform !== 'linux') throw new Error('Descriptor-relative native-store inventory requires Linux /proc/self/fd')
  if (!Number.isSafeInteger(input.maxEntries) || input.maxEntries < 1) throw new Error('Native-store entry ceiling must be a positive safe integer')
  if (!Number.isSafeInteger(input.uid) || input.uid < 0) throw new Error('Native-store writer UID must be a nonnegative safe integer')
  for (const { root } of input.stores) {
    if (!root || root.includes('\\') || root.includes('\0') || root.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Native-store root must be a normalized relative POSIX path')
    }
  }
  const found: DeclaredSessionFile<Store>[] = []
  const rejected: string[] = []
  const owner = await input.home.stat()
  if (!owner.isDirectory()) throw new Error('Native-store HOME handle must name a directory')
  try {
    for (const declaration of input.stores) {
      input.signal?.throwIfAborted()
      const { root, store } = declaration
      let rootHandle: FileHandle | undefined
      try { rootHandle = await openDirectoryPath(input.home, root) }
      catch { rejected.push(`store_directory_unreadable:${root}`); continue }
      // Declared alternative stores need not exist yet; an absent archive is not a missing session.
      if (!rootHandle) continue
      const pending: Array<{ handle: FileHandle; relative: string }> = [{ handle: rootHandle, relative: '' }]
      let visited = 0
      let capped = false
      try {
        while (pending.length > 0) {
          const { handle: directory, relative } = pending.pop()!
          try {
            input.signal?.throwIfAborted()
            if (visited >= input.maxEntries) { capped = true; continue }
            let entries: Dirent[]
            try { entries = await readdir(inDirectory(directory), { withFileTypes: true }) }
            catch { rejected.push(`store_directory_unreadable:${root}/${relative}`); continue }
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
              input.signal?.throwIfAborted()
              if (visited >= input.maxEntries) { capped = true; break }
              visited++
              const child = relative ? `${relative}/${entry.name}` : entry.name
              if (entry.isDirectory()) {
                const opened = await open(inDirectory(directory, entry.name), DIRECTORY_FLAGS).catch(() => undefined)
                if (opened) pending.push({ handle: opened, relative: child })
                else rejected.push(`store_directory_unreadable:${root}/${child}`)
              } else if (declaration.matches(child)) {
                const path = `${root}/${child}`
                if (!entry.isFile()) { rejected.push(`store_file_not_regular:${path}`); continue }
                const opened = await open(inDirectory(directory, entry.name), FILE_FLAGS).catch(() => undefined)
                if (!opened) { rejected.push(`store_file_unreadable:${path}`); continue }
                const stats = await opened.stat().catch(() => undefined)
                if (!stats?.isFile() || stats.uid !== input.uid) {
                  await opened.close()
                  rejected.push(`store_file_not_owned:${path}${stats ? ` file_uid=${stats.uid} file_gid=${stats.gid} expected_uid=${input.uid} home_uid=${owner.uid} nlink=${stats.nlink}` : ''}`)
                  continue
                }
                found.push({ store, path, handle: opened })
              }
            }
          } finally { await directory.close() }
        }
      } finally { await Promise.all(pending.splice(0).map((item) => item.handle.close())) }
      if (capped) rejected.push(`store_entries_capped:${root}`)
    }
    return { files: found.sort((a, b) => a.path.localeCompare(b.path)), rejected }
  } catch (error) {
    await Promise.all(found.map((file) => file.handle.close()))
    throw error
  }
}

/** Length of the prefix of the first `limit` bytes that ends on a newline. Does not modify the source. */
export async function completeLinePrefix(handle: FileHandle, limit: number): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Native-store byte ceiling must be a nonnegative safe integer')
  const window = Buffer.allocUnsafe(64 * 1024)
  for (let end = limit; end > 0;) {
    const start = Math.max(0, end - window.length)
    const { bytesRead } = await handle.read(window, 0, end - start, start)
    const newline = window.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (newline >= 0) return start + newline + 1
    end = start
  }
  return 0
}
