import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexReader, codexRefForFile } from '../src/index.js'

const fixture = join(import.meta.dirname, 'fixtures', 'codex', 'rollout-2026-10-17T10-00-00-01a20000-0000-7000-8000-000000000001.jsonl')

describe('Codex exec status', () => {
  it('sets each command span from its recorded exit code', async () => {
    const s = await codexReader.read(codexRefForFile(fixture))
    expect(s.toolCalls.map((t) => [t.name, t.status])).toEqual([
      ['exec_command', 'error'], // Process exited with code 1
      ['exec_command', 'completed'], // code 0; "code 7" in the body is output, not status
      ['exec_command', 'completed'], // still running: no exit status yet, so not an error
      ['exec', 'error'], // code mode: tools.exec_command result has exit_code 2
      ['exec', 'completed'],
    ])
  })
})
