import { open, readFile, stat } from 'node:fs/promises'

/**
 * Reads selected values out of a JSON file without materializing the whole
 * document (#534): a retention manifest can run past V8's string limit while
 * the values a listing needs stay small. Ordinary files parse whole; the rest
 * stream one buffer at a time, and only the subtrees `wanted` accepts are
 * captured, each under a byte ceiling.
 */

const BUFFER_BYTES = 1024 * 1024

/** A wanted value that itself exceeds `maxCaptureBytes`; the value, not the file, is refused. */
export class JsonValueTooLarge extends Error {
  constructor(readonly path: string, readonly maxCaptureBytes: number) {
    super(`value at ${path} exceeds ${maxCaptureBytes} bytes`)
  }
}

export interface ReadJsonValuesOptions {
  /** Files at or under this size parse whole. Default 8 MiB. */
  fastPathBytes?: number
  /** Ceiling per captured value. Default 64 MiB. */
  maxCaptureBytes?: number
  signal?: AbortSignal
}

const escapeKey = (key: string): string => key.replace(/~/gu, '~0').replace(/\//gu, '~1')

/** Deep-walk an in-memory document collecting the values `wanted` accepts, by the same paths the scanner reports. */
function walkMemory(value: unknown, path: string, wanted: (path: string) => boolean, out: Map<string, unknown>): void {
  if (wanted(path)) {
    out.set(path, value)
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walkMemory(value[i], `${path}/${i}`, wanted, out)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) walkMemory(entry, `${path}/${escapeKey(key)}`, wanted, out)
  }
}

/**
 * The selected values of the JSON document at `path`, keyed by RFC 6901-ish
 * paths from the root (`/nativeSessions`, `/source/attempts/0/executionId`).
 * String values are returned decoded; captured subtrees are parsed.
 */
export async function readJsonValues(
  path: string,
  wanted: (path: string) => boolean,
  options: ReadJsonValuesOptions = {},
): Promise<Map<string, unknown>> {
  const fastPathBytes = options.fastPathBytes ?? 8 * 1024 * 1024
  const maxCaptureBytes = options.maxCaptureBytes ?? 64 * 1024 * 1024
  const { size } = await stat(path)
  if (size <= fastPathBytes) {
    const document = JSON.parse(await readFile(path, 'utf8')) as unknown
    const out = new Map<string, unknown>()
    walkMemory(document, '', wanted, out)
    return out
  }
  const scanner = new StreamingScanner(path, options.signal)
  try {
    return await scanner.scan(wanted, maxCaptureBytes)
  } finally {
    await scanner.close().catch(() => undefined)
  }
}

class StreamingScanner {
  private readonly chunk = Buffer.alloc(BUFFER_BYTES)
  private buffer: Buffer = Buffer.alloc(0)
  private offset = 0
  private capturing: number[] | undefined
  private capturedBytes = 0
  private overflow: { path: string } | undefined

  constructor(
    private readonly path: string,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async close(): Promise<void> {
    await this.handle?.close()
  }

  private handle: Awaited<ReturnType<typeof open>> | undefined

  private async fill(): Promise<boolean> {
    this.signal?.throwIfAborted()
    this.handle ??= await open(this.path, 'r')
    const { bytesRead } = await this.handle.read(this.chunk, 0, BUFFER_BYTES, null)
    this.buffer = bytesRead === BUFFER_BYTES ? this.chunk : this.chunk.subarray(0, bytesRead)
    this.offset = 0
    return bytesRead > 0
  }

  private async peek(): Promise<number> {
    if (this.offset < this.buffer.length) return this.buffer[this.offset]!
    if (await this.fill()) return this.buffer[this.offset]!
    return -1
  }

  private async next(): Promise<number> {
    const byte = await this.peek()
    if (byte >= 0) {
      this.offset += 1
      if (this.capturing !== undefined) {
        this.capturedBytes += 1
        if (this.capturedBytes <= this.maxCaptureBytes) this.capturing.push(byte)
        else if (this.overflow === undefined) this.overflow = { path: this.capturePath }
      }
    }
    return byte
  }

  private maxCaptureBytes = 0
  private capturePath = ''

  async scan(wanted: (path: string) => boolean, maxCaptureBytes: number): Promise<Map<string, unknown>> {
    this.maxCaptureBytes = maxCaptureBytes
    const out = new Map<string, unknown>()
    await this.value('', wanted, out)
    await this.trailing()
    if (this.overflow !== undefined) throw new JsonValueTooLarge(this.overflow.path, maxCaptureBytes)
    return out
  }

  private async trailing(): Promise<void> {
    for (;;) {
      while (this.offset < this.buffer.length) {
        if (!isSpace(this.buffer[this.offset]!)) throw new SyntaxError('trailing content after the JSON document')
        this.offset += 1
      }
      if (!(await this.fill())) return
    }
  }

  private beginCapture(): void {
    this.capturing = []
    this.capturedBytes = 0
  }

  private async endCapture(): Promise<string> {
    const bytes = Buffer.from(this.capturing ?? [])
    this.capturing = undefined
    return bytes.toString('utf8')
  }

  private async skipSpaces(): Promise<void> {
    for (;;) {
      while (this.offset < this.buffer.length && isSpace(this.buffer[this.offset]!)) this.offset += 1
      if (this.offset < this.buffer.length) return
      if (!(await this.fill())) return
    }
  }

  /** One string token, decoded; the opening quote is already consumed. */
  private async stringToken(): Promise<string> {
    let escaped = false
    const raw: number[] = []
    for (;;) {
      const byte = await this.next()
      if (byte < 0) throw new SyntaxError('unterminated string')
      if (escaped) {
        escaped = false
        raw.push(byte)
      } else if (byte === 0x5c) {
        escaped = true
        raw.push(byte)
      } else if (byte === 0x22) {
        return JSON.parse(`"${Buffer.from(raw).toString('utf8')}"`)
      } else {
        raw.push(byte)
      }
    }
  }

  private async literal(): Promise<void> {
    for (;;) {
      const byte = await this.peek()
      if (byte < 0 || !/[a-z]/.test(String.fromCharCode(byte))) return
      await this.next()
    }
  }

  private async numberToken(): Promise<void> {
    for (;;) {
      const byte = await this.peek()
      if (byte < 0 || !/[0-9+.eE-]/.test(String.fromCharCode(byte))) return
      await this.next()
    }
  }

  /** The raw bytes of one complete value, captured; truncated to null when the value exceeded the ceiling. */
  private async rawValue(path: string): Promise<string | null> {
    this.beginCapture()
    this.capturePath = path
    await this.skipValueSyntax(path)
    const overflowed = this.overflow?.path === path
    const raw = await this.endCapture()
    return overflowed ? null : raw
  }

  /** Walk one value, reporting wanted paths below `path`. */
  private async value(path: string, wanted: (path: string) => boolean, out: Map<string, unknown>): Promise<void> {
    await this.skipSpaces()
    if (path !== '' && wanted(path)) {
      const raw = await this.rawValue(path)
      if (raw !== null) out.set(path, JSON.parse(raw))
      return
    }
    const byte = await this.peek()
    if (byte === 0x7b) await this.object(path, wanted, out)
    else if (byte === 0x5b) await this.array(path, wanted, out)
    else await this.skipValueSyntax(path)
  }

  private async object(path: string, wanted: (path: string) => boolean, out: Map<string, unknown>): Promise<void> {
    await this.next() // {
    await this.skipSpaces()
    if ((await this.peek()) === 0x7d) {
      await this.next()
      return
    }
    for (;;) {
      await this.skipSpaces()
      if ((await this.peek()) !== 0x22) throw new SyntaxError('object key expected')
      await this.next()
      const key = await this.stringToken()
      await this.skipSpaces()
      if ((await this.next()) !== 0x3a) throw new SyntaxError('colon expected')
      await this.value(`${path}/${escapeKey(key)}`, wanted, out)
      await this.skipSpaces()
      const sep = await this.next()
      if (sep === 0x7d) return
      if (sep !== 0x2c) throw new SyntaxError('comma or } expected')
    }
  }

  private async array(path: string, wanted: (path: string) => boolean, out: Map<string, unknown>): Promise<void> {
    await this.next() // [
    await this.skipSpaces()
    if ((await this.peek()) === 0x5d) {
      await this.next()
      return
    }
    for (let index = 0; ; index += 1) {
      await this.value(`${path}/${index}`, wanted, out)
      await this.skipSpaces()
      const sep = await this.next()
      if (sep === 0x5d) return
      if (sep !== 0x2c) throw new SyntaxError('comma or ] expected')
    }
  }

  /** Skip exactly one value's bytes, string- and nesting-aware, without reporting children. */
  private async skipValueSyntax(path: string): Promise<void> {
    await this.skipSpaces()
    const byte = await this.peek()
    if (byte === 0x22) {
      await this.next()
      let escaped = false
      for (;;) {
        const c = await this.next()
        if (c < 0) throw new SyntaxError('unterminated string')
        if (escaped) escaped = false
        else if (c === 0x5c) escaped = true
        else if (c === 0x22) return
      }
    }
    if (byte === 0x7b || byte === 0x5b) {
      let depth = 0
      for (;;) {
        const c = await this.next()
        if (c < 0) throw new SyntaxError('unterminated structure')
        if (c === 0x22) {
          let escaped = false
          for (;;) {
            const s = await this.next()
            if (s < 0) throw new SyntaxError('unterminated string')
            if (escaped) escaped = false
            else if (s === 0x5c) escaped = true
            else if (s === 0x22) break
          }
          continue
        }
        if (c === 0x7b || c === 0x5b) depth += 1
        else if (c === 0x7d || c === 0x5d) {
          depth -= 1
          if (depth === 0) return
        }
      }
    }
    if (byte >= 0 && /[0-9-]/.test(String.fromCharCode(byte))) {
      await this.numberToken()
      return
    }
    await this.literal()
  }
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}
