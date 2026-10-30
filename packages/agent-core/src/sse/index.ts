/**
 * SSE Utilities
 *
 * The one Server-Sent Events wire-format implementation: frame parsing and
 * framing, plus the JSON event layer and stream usage extraction built on it.
 * Everything here is pure ECMAScript over `ReadableStream`/`TextDecoder`
 * globals and imports nothing, so Node, browser and Cloudflare Worker bundles
 * can take this subpath without pulling a dependency.
 *
 * Frame parser guarantees (WHATWG Server-Sent Events, §9.2 "Interpreting an
 * event stream"):
 *   - Buffers frames that straddle chunk boundaries; `push()` emits only
 *     complete frames and `flush()` dispatches a trailing frame whose
 *     terminating blank line never arrived.
 *   - Accepts LF and CRLF line terminators interchangeably. Bare CR is
 *     intentionally not treated as a terminator: no known emitter uses
 *     it, and supporting it would risk splitting payloads that
 *     legitimately contain CR.
 *   - Joins multi-line `data:` fields with "\n" (§9.2.6 step 3).
 *   - Skips comment lines (a leading ":") — the heartbeat mechanism.
 *   - Ignores `retry:` and unrecognized fields.
 *   - Strips one leading U+FEFF (BOM) from the stream.
 *   - Applies the `event:`/`id:` state of a frame only to that frame.
 *
 * The frame layer does no JSON parsing, reconnect/`Last-Event-ID` tracking or
 * event-type filtering; `SSEChunkParser` adds JSON payload handling on top.
 */

/** Raw SSE event data from stream */
export interface SSEEventData {
  type: string;
  // Tool events
  toolName?: string;
  name?: string;
  callId?: string;
  input?: unknown;
  arguments?: unknown;
  output?: unknown;
  result?: unknown;
  durationMs?: number;
  // Error events
  error?: string;
  message?: string;
  code?: string;
  // Status events
  status?: string;
  // Token/LLM events
  tokens?: number;
  model?: string;
  // Usage fields (Anthropic format)
  inputTokens?: number;
  outputTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // Usage object (some providers wrap in usage field)
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // Generic
  [key: string]: unknown;
}

/**
 * Parse raw SSE data string into structured event data.
 *
 * Handles the standard SSE format:
 * ```
 * event: eventType
 * data: {"json": "payload"}
 * ```
 */
export function parseSSEData(rawData: string): SSEEventData | null {
  try {
    const lines = rawData.split("\n");
    let eventType: string | undefined;
    let data: string | undefined;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }

    if (data) {
      const parsed = JSON.parse(data);
      return {
        type: eventType || parsed.type || "unknown",
        ...parsed,
      };
    }
  } catch {
    // Ignore parse errors (heartbeats, malformed events)
  }
  return null;
}

// ============================================================================
// Frame Parsing and Framing
// ============================================================================

/**
 * One parsed SSE frame: the fields accumulated between blank lines.
 *
 * `event` and `id` share no memory with the chunk the frame arrived in, so a
 * consumer can keep them as long as it keeps its events. `data` can share
 * that memory: parse it, and keep what the parse returns.
 */
export interface SSEFrame {
  /** Value of the `event:` field; "" when the frame carries none. */
  event: string;
  /** `data:` field lines joined with "\n". */
  data: string;
  /** Value of the `id:` field; undefined when the frame carries none. */
  id?: string;
}

/**
 * A copy of `value` that shares no memory with the string it was cut from.
 *
 * V8 can return a short substring of a long string as a view that keeps the
 * whole string alive. Consumers keep event names and ids as long as they keep
 * events, so a view would keep every chunk its frame arrived in alive.
 */
function detached(value: string): string {
  return value === "" ? value : (JSON.parse(JSON.stringify(value)) as string);
}

/** Options for {@link streamSSEFrames}. */
export interface SSEStreamOptions {
  /**
   * Aborts the read loop. When the signal fires, the generator throws a
   * `DOMException` named "AbortError" so consumers can distinguish a
   * cancellation from a clean end-of-stream without inspecting signal
   * state.
   */
  signal?: AbortSignal;
  /**
   * The longest silence the stream may keep, read before each chunk read.
   * Any bytes reset it, comment heartbeats included, because a heartbeat is
   * the producer saying the connection is still live. A read that outlasts it
   * throws {@link SSEStreamSilentError}. `undefined` waits without bound, which
   * suits a producer that promises no heartbeat.
   */
  idleMs?: () => number | undefined;
}

/**
 * Thrown when a stream sends no bytes for longer than its `idleMs`. A
 * producer that heartbeats would have written in that time, so the
 * connection is dead even though it never closed: a half-open TCP connection
 * or a stalled proxy hold the socket open while nothing arrives.
 */
export class SSEStreamSilentError extends Error {
  override readonly name = "SSEStreamSilentError";
  readonly idleMs: number;
  constructor(idleMs: number) {
    super(`SSE stream sent no bytes for ${idleMs} ms`);
    this.idleMs = idleMs;
  }
}

export type SSEFragment =
  | {
      type: "field";
      field: string | undefined;
      prefix: string;
    }
  | { type: "value"; value: string }
  | { type: "line-end" | "frame-end"; ending: string };

/**
 * Incremental SSE frame parser. Feed decoded text via push(); call flush()
 * when the stream ends. Complete frames and bounded fragments share one
 * scanner and one parser lifetime.
 */
export class SSEFrameParser {
  private prefix = "";
  private started = false;
  private cr = false;
  private bomChecked = false;

  /**
   * Yield raw field prefixes, values and line/frame endings without retaining
   * a complete line or frame. Comments and unknown fields survive; one initial
   * BOM is consumed and CRLF remains intact. Pass final=true once at EOF.
   * Drain each generator before supplying the next chunk. An instance owns
   * either fragments or push/flush; mixing those modes loses collected state.
   */
  *fragments(chunk: string, final = false): Generator<SSEFragment> {
    let text = chunk;
    if (!this.bomChecked && text.length) {
      this.bomChecked = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.cr) {
      text = `\r${text}`;
      this.cr = false;
    }
    let cursor = 0;
    for (;;) {
      const newline = text.indexOf("\n", cursor);
      const end = newline < 0 ? text.length : newline;
      const trailingCr = text[end - 1] === "\r" && end > cursor;
      const value = text.slice(cursor, trailingCr ? end - 1 : end);
      yield* this.value(value);
      if (newline < 0) {
        this.cr = trailingCr;
        break;
      }
      yield* this.end(trailingCr ? "\r\n" : "\n");
      cursor = newline + 1;
    }
    if (final) {
      if (this.started || this.prefix || this.cr)
        yield* this.end(this.cr ? "\r" : "");
      yield { type: "frame-end", ending: "" };
      this.cr = false;
    }
  }

  private *value(value: string): Generator<SSEFragment> {
    let cursor = 0;
    while (!this.started && cursor < value.length) {
      const next = value[cursor++]!;
      if (this.prefix.endsWith(":")) {
        // The spec removes one optional leading space from the field value.
        const prefix = this.prefix + (next === " " ? next : "");
        yield { type: "field", field: this.prefix.slice(0, -1), prefix };
        this.started = true;
        if (next !== " ") cursor--;
      } else {
        this.prefix += next;
        if (
          !["data:", "event:", "id:", "retry:"].some((name) =>
            name.startsWith(this.prefix),
          )
        ) {
          yield { type: "field", field: undefined, prefix: this.prefix };
          this.started = true;
        }
      }
    }
    if (cursor < value.length)
      yield { type: "value", value: value.slice(cursor) };
  }

  private *end(ending: string): Generator<SSEFragment> {
    if (!this.started && this.prefix)
      yield {
        type: "field",
        field: this.prefix.endsWith(":") ? this.prefix.slice(0, -1) : undefined,
        prefix: this.prefix,
      };
    yield {
      type: this.started || this.prefix ? "line-end" : "frame-end",
      ending,
    };
    this.prefix = "";
    this.started = false;
  }

  private field: string | undefined;
  private line = "";
  private frameEvent = "";
  private frameId: string | undefined;
  private frameDataLines: string[] | null = null;

  /**
   * Append a decoded text chunk and return every frame the chunk
   * completes. Frame state survives across calls: one frame can
   * straddle any number of chunks.
   */
  push(chunk: string): SSEFrame[] {
    return this.collect(this.fragments(chunk));
  }
  /**
   * End-of-stream: process the unterminated trailing line, then
   * dispatch a dangling frame that never got its blank line.
   * Well-behaved servers end frames with "\n\n", but some close early.
   */
  flush(): SSEFrame[] {
    return this.collect(this.fragments("", true));
  }

  private collect(fragments: Iterable<SSEFragment>): SSEFrame[] {
    const frames: SSEFrame[] = [];
    for (const fragment of fragments) {
      // Comment and unknown-field fragments survive raw mode, but carry no frame payload.
      if (fragment.type === "field") this.field = fragment.field;
      else if (fragment.type === "value" && this.field !== undefined)
        this.line += fragment.value;
      else if (fragment.type === "line-end") {
        if (this.field === "data") (this.frameDataLines ??= []).push(this.line);
        if (this.field === "event") this.frameEvent = this.line.trim();
        if (this.field === "id") this.frameId = this.line.trim();
        this.field = undefined;
        this.line = "";
      } else if (fragment.type === "frame-end") {
        const frame = this.dispatch();
        if (frame) frames.push(frame);
      }
    }
    return frames;
  }

  /**
   * Dispatch the accumulated frame. A frame with no `data:` field (an
   * `event:`/`id:`-only frame, or a bare comment) produces nothing, and
   * its field state is consumed and reset either way.
   */
  private dispatch(): SSEFrame | null {
    const frame = this.frameDataLines
      ? {
          event: detached(this.frameEvent),
          data: this.frameDataLines.join("\n"),
          id: this.frameId ? detached(this.frameId) : undefined,
        }
      : null;
    this.frameEvent = "";
    this.frameId = undefined;
    this.frameDataLines = null;
    return frame;
  }
}

/**
 * Serialize one frame to its wire form. Multi-line `data` becomes one
 * `data:` line per source line so the payload survives the trip without
 * premature frame dispatch.
 */
export function encodeSSEFrame(frame: {
  data: string;
  event?: string;
  id?: string;
}): string {
  let out = "";
  if (frame.event !== undefined) out += `event: ${frame.event}\n`;
  if (frame.id !== undefined) out += `id: ${frame.id}\n`;
  for (const line of frame.data.split("\n")) out += `data: ${line}\n`;
  return `${out}\n`;
}

/**
 * Read a streaming SSE response body into parsed frames.
 *
 * @throws `TypeError` when the body is missing.
 * @throws `DOMException` with `name === "AbortError"` on cancellation —
 *   including the WHATWG-fetch variant where an aborted body resolves
 *   `done: true` instead of rejecting the read.
 */
export async function* streamSSEFrames(
  body: ReadableStream<Uint8Array> | null | undefined,
  options?: SSEStreamOptions,
): AsyncGenerator<SSEFrame> {
  if (!body) {
    throw new TypeError("SSE stream has no response body");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEFrameParser();
  const { signal, idleMs } = options ?? {};
  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const limit = idleMs?.();
    if (limit === undefined) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SSEStreamSilentError(limit)),
          limit,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
  let completed = false;
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException("SSE stream aborted", "AbortError");
      }
      const { done, value } = await read();
      if (done) {
        if (signal?.aborted) {
          throw new DOMException("SSE stream aborted", "AbortError");
        }
        break;
      }
      for (const frame of parser.push(
        decoder.decode(value, { stream: true }),
      )) {
        yield frame;
      }
    }
    // A final decode() flushes a partial multi-byte character left in
    // the decoder; flush() then dispatches a dangling frame.
    for (const frame of parser.push(decoder.decode())) yield frame;
    for (const frame of parser.flush()) yield frame;
    completed = true;
  } finally {
    // Returning early (a consumer that breaks on a terminal event)
    // closes the generator but does not by itself cancel a locked fetch
    // body. Cancel before releasing so the connection is not leaked
    // until the server times out.
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// ============================================================================
// JSON Event Parsing (chunked SSE)
// ============================================================================

export interface SSEParserOptions<T = unknown> {
  /** Log malformed data lines (default: false) */
  logMalformed?: boolean;
  /** Custom data transformer */
  transform?: (raw: string) => T | null;
}

export interface ParsedSSEEvent<T = unknown> {
  data: T;
  rawData: string;
  eventId?: string;
  eventType?: string;
}

/**
 * Incremental JSON event parser for chunked streams, framed by
 * {@link SSEFrameParser}. Feed decoded string chunks via push(); call flush()
 * on stream end. Frames whose trimmed data is empty produce no event.
 */
export class SSEChunkParser<T = unknown> {
  private readonly frames = new SSEFrameParser();
  constructor(private readonly options: SSEParserOptions<T> = {}) {}

  push(chunk: string): ParsedSSEEvent<T>[] {
    return this.toEvents(this.frames.push(chunk));
  }

  flush(): ParsedSSEEvent<T>[] {
    return this.toEvents(this.frames.flush());
  }

  private toEvents(frames: SSEFrame[]): ParsedSSEEvent<T>[] {
    return frames.flatMap((frame) => toSSEEvents(frame, this.options));
  }
}

function toSSEEvents<T>(
  frame: SSEFrame,
  options: SSEParserOptions<T>,
): ParsedSSEEvent<T>[] {
  const rawData = frame.data.trim();
  if (!rawData) {
    return [];
  }

  let data: T;
  if (options.transform) {
    const transformed = options.transform(rawData);
    if (transformed === null) {
      if (options.logMalformed) {
        console.warn("SSE transform returned null:", rawData.slice(0, 100));
      }
      return [];
    }
    data = transformed;
  } else {
    try {
      data = JSON.parse(rawData) as T;
    } catch {
      if (options.logMalformed) {
        console.warn("SSE parse failed:", rawData.slice(0, 100));
      }
      data = rawData as unknown as T;
    }
  }

  return [
    { data, rawData, eventId: frame.id, eventType: frame.event || undefined },
  ];
}

/**
 * Parse SSE stream into typed events via async iteration.
 */
export async function* parseSSEStream<T = unknown>(
  stream: ReadableStream<Uint8Array>,
  options: SSEParserOptions<T> = {},
): AsyncGenerator<ParsedSSEEvent<T>> {
  for await (const frame of streamSSEFrames(stream)) {
    yield* toSSEEvents(frame, options);
  }
}

/**
 * Consume SSE stream with callbacks.
 */
export async function consumeSSEStream<T = unknown>(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ParsedSSEEvent<T>) => void,
  onError: (error: Error) => void,
  options: SSEParserOptions<T> = {},
): Promise<void> {
  try {
    for await (const event of parseSSEStream<T>(stream, options))
      onEvent(event);
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================================
// Stream Usage Extraction
// ============================================================================

/** Token usage extracted from stream */
export interface StreamTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Accumulated usage from a stream session */
export interface StreamUsageAccumulator {
  /** Total tokens from all events */
  usage: StreamTokenUsage;
  /** Number of LLM response events */
  responseCount: number;
  /** Number of tool calls */
  toolCallCount: number;
  /** Model ID if detected from events */
  modelId?: string;
  /** Start time of accumulation */
  startedAt: Date;
  /** Duration in ms (set on finalize) */
  durationMs?: number;
}

/** Event types that contain token information (Anthropic SDK format) */
const TOKEN_EVENTS = new Set(["message.stop", "content_block_stop"]);

/**
 * StreamUsageExtractor - Accumulates token usage from SSE events.
 *
 * Usage:
 * ```typescript
 * const extractor = createStreamUsageExtractor();
 *
 * // In your stream callback
 * for await (const event of stream) {
 *   extractor.processEvent(event);
 *   // ... handle event
 * }
 *
 * const usage = extractor.finalize();
 * billingService.recordUsage({ usage: usage.usage, ... });
 * ```
 */
export class StreamUsageExtractor {
  private accumulator: StreamUsageAccumulator;
  private finalized = false;

  constructor() {
    this.accumulator = {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      responseCount: 0,
      toolCallCount: 0,
      startedAt: new Date(),
    };
  }

  /**
   * Process a raw SSE string (event: xxx\ndata: {...}).
   */
  processRawSSE(raw: string): void {
    const parsed = parseSSEData(raw);
    if (parsed) {
      this.processEvent(parsed);
    }
  }

  /**
   * Process a parsed SSE event object.
   */
  processEvent(event: SSEEventData | Record<string, unknown>): void {
    if (this.finalized) {
      throw new Error("StreamUsageExtractor already finalized");
    }

    const eventType = (event as SSEEventData).type ?? event.type;

    // Handle message.part.updated (canonical event for all part types)
    if (eventType === "message.part.updated") {
      const part = (event as { part?: { type?: string; tool?: string } }).part;
      const partType = part?.type;

      // Text and reasoning parts count as LLM responses
      if (partType === "text" || partType === "reasoning") {
        this.extractTokens(event);
        this.accumulator.responseCount++;
      }

      // Tool parts count as tool calls
      if (partType === "tool" && part?.tool) {
        this.accumulator.toolCallCount++;
      }

      return;
    }

    // Extract token counts from Anthropic SDK format events
    if (TOKEN_EVENTS.has(eventType as string)) {
      this.extractTokens(event);
      this.accumulator.responseCount++;
    }

    // Extract model ID if present
    if (!this.accumulator.modelId && event.model) {
      this.accumulator.modelId = String(event.model);
    }

    // Handle usage summary events (some providers send final usage)
    if (eventType === "usage" || event.usage) {
      this.extractUsageSummary(event);
    }

    // Handle message_stop with usage (Anthropic format)
    if (eventType === "message_stop" && event.usage) {
      this.extractUsageSummary(event);
    }
  }

  /**
   * Finalize and return accumulated usage.
   * Sets duration and marks extractor as complete.
   */
  finalize(): StreamUsageAccumulator {
    if (this.finalized) {
      return this.accumulator;
    }

    this.finalized = true;
    this.accumulator.durationMs =
      Date.now() - this.accumulator.startedAt.getTime();

    return this.accumulator;
  }

  /**
   * Get current accumulated usage (without finalizing).
   */
  current(): Readonly<StreamUsageAccumulator> {
    return this.accumulator;
  }

  /**
   * Reset the extractor for reuse.
   */
  reset(): void {
    this.accumulator = {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      responseCount: 0,
      toolCallCount: 0,
      startedAt: new Date(),
    };
    this.finalized = false;
  }

  private extractTokens(event: Record<string, unknown>): void {
    // Direct token count (simple format)
    if (typeof event.tokens === "number") {
      this.accumulator.usage.outputTokens += event.tokens;
    }

    // Output tokens (explicit)
    if (typeof event.outputTokens === "number") {
      this.accumulator.usage.outputTokens += event.outputTokens;
    }
    if (typeof event.output_tokens === "number") {
      this.accumulator.usage.outputTokens += event.output_tokens;
    }

    // Input tokens (usually from final summary)
    if (typeof event.inputTokens === "number") {
      this.accumulator.usage.inputTokens = Math.max(
        this.accumulator.usage.inputTokens,
        event.inputTokens,
      );
    }
    if (typeof event.input_tokens === "number") {
      this.accumulator.usage.inputTokens = Math.max(
        this.accumulator.usage.inputTokens,
        event.input_tokens,
      );
    }

    // Cache tokens (Anthropic format)
    if (typeof event.cache_read_input_tokens === "number") {
      this.accumulator.usage.cacheReadTokens =
        (this.accumulator.usage.cacheReadTokens ?? 0) +
        event.cache_read_input_tokens;
    }
    if (typeof event.cache_creation_input_tokens === "number") {
      this.accumulator.usage.cacheWriteTokens =
        (this.accumulator.usage.cacheWriteTokens ?? 0) +
        event.cache_creation_input_tokens;
    }
  }

  private extractUsageSummary(event: Record<string, unknown>): void {
    const usage = (event.usage as Record<string, unknown>) ?? event;

    if (typeof usage.input_tokens === "number") {
      this.accumulator.usage.inputTokens = Math.max(
        this.accumulator.usage.inputTokens,
        usage.input_tokens,
      );
    }
    if (typeof usage.output_tokens === "number") {
      this.accumulator.usage.outputTokens = Math.max(
        this.accumulator.usage.outputTokens,
        usage.output_tokens,
      );
    }
    if (typeof usage.cache_read_input_tokens === "number") {
      this.accumulator.usage.cacheReadTokens = usage.cache_read_input_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === "number") {
      this.accumulator.usage.cacheWriteTokens =
        usage.cache_creation_input_tokens;
    }
  }
}

/**
 * Create a new StreamUsageExtractor.
 */
export function createStreamUsageExtractor(): StreamUsageExtractor {
  return new StreamUsageExtractor();
}

/**
 * Create a callback wrapper that extracts usage while forwarding events.
 *
 * Usage:
 * ```typescript
 * const { callback, getUsage } = createUsageCallback((event) => {
 *   // your event handler
 * });
 *
 * await orchestrator.executeAgentStream(projectRef, request, callback);
 * const usage = getUsage();
 * ```
 */
export function createUsageCallback<T extends Record<string, unknown>>(
  forward?: (event: T) => void,
): {
  callback: (event: T) => void;
  getUsage: () => StreamUsageAccumulator;
  extractor: StreamUsageExtractor;
} {
  const extractor = createStreamUsageExtractor();

  return {
    callback: (event: T) => {
      extractor.processEvent(event);
      forward?.(event);
    },
    getUsage: () => extractor.finalize(),
    extractor,
  };
}
