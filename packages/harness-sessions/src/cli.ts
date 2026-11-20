#!/usr/bin/env node
import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { listCapture, RETENTION_SESSIONS } from './capture.js'
import { isNativeStoreDatabase, nativeStoreSessions } from './native-store.js'
import { listReaders, readerFor } from './registry.js'
import type { SessionRef } from './schema.js'

function usage(): never {
  process.stderr.write('usage: harness-sessions read <file|home|capture> [--harness h] [--session id] [--cwd dir] [--summary] [--json]\n')
  process.exit(2)
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function harnessOfFile(path: string): string | null {
  const absolute = resolve(path).split(sep).join('/')
  const known = listReaders().find(reader => reader.stores.some(store => absolute.includes('/' + store.root + '/')))
  return known?.harness ?? (/rollout-[^/]*\.jsonl$/u.test(path) ? 'codex' : null)
}

async function refsForFile(path: string, harness: string | null, session: string | null): Promise<SessionRef[]> {
  if (await isNativeStoreDatabase(path)) {
    return nativeStoreSessions(path, { ...(harness && { harness }), ...(session && { nativeSessionId: session }) })
  }
  const h = harness ?? harnessOfFile(path)
  if (h === null) throw new Error(`cannot tell which harness wrote ${path}; pass --harness`)
  const reader = readerFor(h)
  if (!reader.refForFile) throw new Error(`The ${reader.harness} reader requires its native store`)
  return [reader.refForFile(path)]
}

async function main(argv: string[]): Promise<void> {
  const [command, target, ...rest] = argv
  if (command !== 'read' || !target) usage()
  let harness: string | null = null
  let session: string | null = null
  let cwd: string | null = null
  let summary = false
  let json = false
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--harness') harness = rest[++i] ?? usage()
    else if (arg === '--session') session = rest[++i] ?? usage()
    else if (arg === '--cwd') cwd = rest[++i] ?? usage()
    else if (arg === '--summary') summary = true
    else if (arg === '--json') json = true
    else usage()
  }

  const refs: SessionRef[] = []
  if (await isDir(target)) {
    if (await isDir(join(target, RETENTION_SESSIONS))) {
      const listing = await listCapture(target)
      for (const missing of listing.missing) process.stderr.write(`missing: ${JSON.stringify(missing)}\n`)
      refs.push(...listing.sessions.map((s) => s.ref).filter((r) => !harness || readerFor(harness).harness === r.harness))
    } else {
      const readers = harness ? [readerFor(harness)] : listReaders()
      for (const reader of readers) refs.push(...(await reader.locate(target, session ? { nativeSessionId: session } : {})))
    }
  } else {
    refs.push(...(await refsForFile(target, harness, session)))
  }
  const selected = refs.filter((r) => (!session || r.nativeSessionId === session) && (!cwd || r.cwd === cwd))

  for (const ref of selected) {
    const reader = readerFor(ref.harness)
    const value = summary ? await reader.summarize(ref) : await reader.read(ref)
    if (json) {
      process.stdout.write(`${JSON.stringify(value)}\n`)
      continue
    }
    const s = summary ? (value as Awaited<ReturnType<typeof reader.summarize>>) : await reader.summarize(ref)
    process.stdout.write(`${s.harness}\t${s.nativeSessionId}\tcalls=${s.modelCalls}\treplies=${s.replies}\ttools=${s.toolCalls}\tending=${s.ending.status}\tmodels=${Object.keys(s.servedModels).join(',')}\t${ref.path}\n`)
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`harness-sessions: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
