#!/usr/bin/env node
/**
 * harness-sessions read <file|home|capture> [--harness h] [--session id] [--summary] [--json]
 *
 * Reads native harness sessions into the normalized form, for callers that are not JavaScript.
 * A file is one session file (or an OpenCode store); a directory is a capture when it holds
 * `__retention__/sessions`, otherwise a HOME searched through every reader's store layout.
 * `--json` prints one JSON document per session, one per line.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listCapture, RETENTION_SESSIONS } from './capture.js'
import { claudeCodeRefForFile } from './formats/claude-code.js'
import { codexRefForFile } from './formats/codex.js'
import { opencodeSessionsInStore } from './formats/opencode.js'
import { piRefForFile } from './formats/pi.js'
import { listReaders, readerFor } from './registry.js'
import type { SessionRef } from './schema.js'

function usage(): never {
  process.stderr.write('usage: harness-sessions read <file|home|capture> [--harness h] [--session id] [--summary] [--json]\n')
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
  if (/\.db$/u.test(path)) return 'opencode'
  if (/(^|\/)\.claude\/projects\//u.test(path)) return 'claude-code'
  if (/(^|\/)\.codex\/sessions\//u.test(path) || /rollout-[^/]*\.jsonl$/u.test(path)) return 'codex'
  if (/(^|\/)\.pi\/agent\/sessions\//u.test(path)) return 'pi'
  return null
}

async function refsForFile(path: string, harness: string | null, session: string | null): Promise<SessionRef[]> {
  const h = harness ?? harnessOfFile(path)
  if (h === null) throw new Error(`cannot tell which harness wrote ${path}; pass --harness`)
  const reader = readerFor(h)
  if (reader.harness === 'opencode') return opencodeSessionsInStore(path, null, session ? { nativeSessionId: session } : {})
  const ref = reader.harness === 'claude-code'
    ? claudeCodeRefForFile(path, /\/subagents\//u.test(path) ? 'parent' : null)
    : reader.harness === 'codex' ? codexRefForFile(path) : piRefForFile(path)
  return [ref]
}

async function main(argv: string[]): Promise<void> {
  const [command, target, ...rest] = argv
  if (command !== 'read' || !target) usage()
  let harness: string | null = null
  let session: string | null = null
  let summary = false
  let json = false
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--harness') harness = rest[++i] ?? usage()
    else if (arg === '--session') session = rest[++i] ?? usage()
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
  const selected = session ? refs.filter((r) => r.nativeSessionId === session) : refs

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
