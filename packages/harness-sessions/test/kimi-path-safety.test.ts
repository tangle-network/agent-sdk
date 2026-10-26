/** Real filesystem controls over the published retained Kimi fixture; no native/model calls. */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { kimiReader, kimiRefForFile, SessionParseError } from '../src/index.js'

const fixtures = join(import.meta.dirname, 'fixtures', 'kimi2')
const provenance = JSON.parse(readFileSync(join(fixtures, 'provenance.json'), 'utf8'))
const fixture = join(fixtures, provenance.fixture)
const id: string = provenance.expectedNativeSessionId
const run = promisify(execFile)

async function retained(home: string, nativeId = id): Promise<string> {
  const path = join(home, '.kimi-code', 'sessions', 'wd_fixture', nativeId, 'agents', 'main', 'wire.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await cp(fixture, path)
  return path
}

async function replace(path: string, kind: string, target: string): Promise<void> {
  await rm(path)
  if (kind === 'symlink') await symlink(target, path)
  else if (kind === 'directory') await mkdir(path)
  else await run('mkfifo', [path], { timeout: 3_000 })
}

describe('Kimi native path safety', () => {
  it('refuses matching links, directories and FIFOs in discovery and both public read modes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-unsafe-path-'))
    try {
      for (const kind of ['symlink', 'directory', 'fifo']) {
        const root = join(home, kind)
        const path = await retained(root)
        const [located] = await kimiReader.locate(root, { nativeSessionId: id })
        expect(located?.nativeSessionId).toBe(id)
        await replace(path, kind, fixture)
        await expect(kimiReader.locate(root, { nativeSessionId: id })).rejects.toThrow(/regular file/u)
        // A ref located while regular must not authorize a replacement before its actual open.
        for (const ref of [located!, kimiRefForFile(path)]) {
          for (const mode of ['read', 'summarize'] as const) {
            await expect(kimiReader[mode](ref, { signal: AbortSignal.timeout(3_000) })).rejects.toThrow(/regular file|ELOOP|symbolic link/iu)
          }
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 20_000)

  it('keeps exact-ID/foreign-HOME absence distinct from selected unsafe evidence and retains companion inventory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-selected-path-'))
    try {
      const path = await retained(home)
      const context = join(dirname(path), 'context.jsonl')
      await writeFile(context, 'retained companion inventory\n')
      for (const kind of ['symlink', 'directory', 'fifo']) {
        const foreign = await retained(home, `session_foreign-${kind}`)
        await replace(foreign, kind, fixture)
      }
      const [ref] = await kimiReader.locate(home, { nativeSessionId: id })
      expect(ref?.files).toEqual([path, context])
      expect(ref?.nativeSessionId).toBe(id)
      const session = await kimiReader.read(ref!, { corruption: 'strict' })
      expect(session.messages.filter((message) => message.actor === 'human')).toHaveLength(1)
      expect(session.toolCalls).toHaveLength(1)
      expect(session.ending.status).toBe('completed')
      expect((await kimiReader.summarize(ref!)).usage).toEqual(session.usage)
      expect(await readFile(context, 'utf8')).toBe('retained companion inventory\n')
      expect(await kimiReader.locate(join(home, 'foreign-HOME'), { nativeSessionId: id })).toEqual([])
      expect(await kimiReader.locate(home, { nativeSessionId: 'session_absent' })).toEqual([])
      await writeFile(path, `${await readFile(fixture, 'utf8')}{\n`)
      await expect(kimiReader.read(ref!, { corruption: 'strict' })).rejects.toBeInstanceOf(SessionParseError)
      await cp(fixture, path)
      expect((await kimiReader.summarize(ref!)).ending.status).toBe('completed')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 20_000)
})
