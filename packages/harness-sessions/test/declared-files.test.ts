/** Real Linux filesystem contract for the host-owned, descriptor-relative copy input. */
import { constants } from 'node:fs'
import { mkdtemp, mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { completeLinePrefix, locateDeclaredSessionFiles } from '../src/index.js'

describe.skipIf(process.platform !== 'linux')('declared native session copy input', () => {
  it('holds the original files after path replacement, refuses links and foreign writers, and returns only complete bounded lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hs-declared-'))
    const home = join(root, 'home')
    await mkdir(join(home, '.claude', 'projects', 'one'), { recursive: true })
    const original = Buffer.from('{"sessionId":"native","text":"雪\\r\\nline"}\npartial')
    const path = join(home, '.claude', 'projects', 'one', 'native.jsonl')
    await writeFile(path, original)
    const outside = join(root, 'outside.jsonl')
    await writeFile(outside, 'outside must never be retained\n')
    await symlink(outside, join(home, '.claude', 'projects', 'one', 'linked.jsonl'))
    await symlink(join(root, 'elsewhere'), join(home, '.claude', 'projects', 'directory-link'))
    const handle = await open(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const store = { name: 'claude-projects' }
    const stores = [{ store, root: '.claude/projects', matches: (path: string) => path.endsWith('.jsonl') }]
    let files: Awaited<ReturnType<typeof locateDeclaredSessionFiles<typeof store>>>['files'] = []
    try {
      const uid = (await handle.stat()).uid
      const located = await locateDeclaredSessionFiles({ home: handle, stores, uid, maxEntries: 100 })
      files = located.files
      expect(files.map((file) => file.path)).toEqual(['.claude/projects/one/native.jsonl'])
      expect(located.rejected).toContain('store_file_not_regular:.claude/projects/one/linked.jsonl')
      await rename(home, `${home}-original`)
      await mkdir(join(home, '.claude', 'projects', 'one'), { recursive: true })
      await writeFile(path, 'replacement must never be retained\n')
      const prefix = await completeLinePrefix(files[0]!.handle, original.length)
      const copied = Buffer.alloc(prefix)
      await files[0]!.handle.read(copied, 0, prefix, 0)
      expect(copied).toEqual(original.subarray(0, original.indexOf(0x0a) + 1))
      expect(await readFile(join(`${home}-original`, '.claude/projects/one/native.jsonl'))).toEqual(original)
      const foreign = await locateDeclaredSessionFiles({ home: handle, stores, uid: uid + 1, maxEntries: 100 })
      expect(foreign.files).toEqual([])
      expect(foreign.rejected.some((reason) => reason.startsWith('store_file_not_owned:'))).toBe(true)
      const missing = await locateDeclaredSessionFiles({ home: handle, stores: [{ ...stores[0]!, root: '.claude/missing' }], uid, maxEntries: 100 })
      expect(missing).toEqual({ files: [], rejected: ['store_directory_unreadable:.claude/missing'] })
      await expect(locateDeclaredSessionFiles({ home: handle, stores: [{ ...stores[0]!, root: '../outside' }], uid, maxEntries: 100 })).rejects.toThrow('normalized relative POSIX path')
    } finally {
      await Promise.all(files.map((file) => file.handle.close()))
      await handle.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names inventory gaps at the entry ceiling and refuses pre-cancelled inventory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hs-declared-bounds-'))
    await mkdir(join(home, 'sessions'))
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl']) await writeFile(join(home, 'sessions', name), '{}\n')
    const handle = await open(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const uid = (await handle.stat()).uid
      const input = { home: handle, uid, maxEntries: 1, stores: [{ store: 'sessions', root: 'sessions', matches: (path: string) => path.endsWith('.jsonl') }] }
      const located = await locateDeclaredSessionFiles(input)
      try {
        expect(located.files.map((file) => file.path)).toEqual(['sessions/a.jsonl'])
        expect(located.rejected).toEqual(['store_entries_capped:sessions'])
      } finally { await Promise.all(located.files.map((file) => file.handle.close())) }
      const controller = new AbortController()
      controller.abort()
      await expect(locateDeclaredSessionFiles({ ...input, signal: controller.signal })).rejects.toThrow()
      expect((await handle.stat()).isDirectory()).toBe(true)
    } finally {
      await handle.close()
      await rm(home, { recursive: true, force: true })
    }
  })
})
