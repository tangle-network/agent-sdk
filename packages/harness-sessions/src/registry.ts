import { claudeCodeReader } from './formats/claude-code.js'
import { codexReader } from './formats/codex.js'
import { kimiReader } from './formats/kimi.js'
import { factoryReader } from './formats/factory.js'
import { grokReader } from './formats/grok.js'
import { hermesReader } from './formats/hermes.js'
import { nanoclawReader } from './formats/nanoclaw.js'
import { openclawReader } from './formats/openclaw.js'
import { primeReader } from './formats/prime.js'
import { opencodeReader } from './formats/opencode.js'
import { piReader } from './formats/pi.js'
import type { HarnessSessionReader, SessionFormatId } from './schema.js'

const READERS: readonly HarnessSessionReader[] = [claudeCodeReader, codexReader, opencodeReader, piReader, kimiReader, factoryReader, grokReader, nanoclawReader, hermesReader, primeReader, openclawReader]

const BY_NAME = new Map<string, HarnessSessionReader>()
for (const reader of READERS) {
  BY_NAME.set(reader.harness, reader)
  for (const alias of reader.aliases) BY_NAME.set(alias, reader)
}

export function listReaders(): readonly HarnessSessionReader[] {
  return READERS
}

export function knownHarnesses(): string[] {
  return [...BY_NAME.keys()].sort()
}

export function readerFor(harnessOrAlias: string): HarnessSessionReader {
  const reader = BY_NAME.get(harnessOrAlias) ?? BY_NAME.get(harnessOrAlias.toLowerCase())
  if (!reader) throw new Error(`no session reader for harness "${harnessOrAlias}"; known: ${knownHarnesses().join(', ')}`)
  return reader
}

export function maybeReaderFor(harnessOrAlias: string): HarnessSessionReader | undefined {
  return BY_NAME.get(harnessOrAlias) ?? BY_NAME.get(harnessOrAlias.toLowerCase())
}

export function readerForFormat(format: SessionFormatId): HarnessSessionReader {
  const reader = READERS.find((r) => r.formats.includes(format))
  if (!reader) throw new Error(`no session reader for format "${format}"`)
  return reader
}
