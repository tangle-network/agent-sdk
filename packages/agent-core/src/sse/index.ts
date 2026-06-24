/**
 * SSE Utilities
 *
 * Shared SSE parsing and stream usage extraction for the SDK.
 * Used by sdk-telemetry, sdk-memory, and other consumers.
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
// Stream Parsing (chunked SSE)
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
 * Incremental SSE parser for chunked streams.
 * Feed decoded string chunks via push(); call flush() on stream end.
 */
export class SSEChunkParser<T = unknown> {
  private buffer = "";
  private currentEvent: { id?: string; event?: string; data?: string } = {};
  private options: SSEParserOptions<T>;

  constructor(options: SSEParserOptions<T> = {}) {
    this.options = options;
  }

  push(chunk: string): ParsedSSEEvent<T>[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return this.processLines(lines);
  }

  flush(): ParsedSSEEvent<T>[] {
    const lines = this.buffer ? [this.buffer] : [];
    this.buffer = "";
    const events = this.processLines(lines);
    const finalEvent = this.parseCurrentEvent();
    if (finalEvent) {
      events.push(finalEvent);
      this.currentEvent = {};
    }
    return events;
  }

  private processLines(lines: string[]): ParsedSSEEvent<T>[] {
    const events: ParsedSSEEvent<T>[] = [];

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line.startsWith(":")) {
        continue;
      }

      if (line === "") {
        const parsed = this.parseCurrentEvent();
        if (parsed) {
          events.push(parsed);
        }
        this.currentEvent = {};
        continue;
      }

      if (line.startsWith("id:")) {
        this.currentEvent.id = line.slice(3).trim();
        continue;
      }

      if (line.startsWith("event:")) {
        this.currentEvent.event = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        let value = line.slice(5);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }
        this.currentEvent.data =
          this.currentEvent.data !== undefined
            ? `${this.currentEvent.data}\n${value}`
            : value;
      }
    }

    return events;
  }

  private parseCurrentEvent(): ParsedSSEEvent<T> | null {
    if (this.currentEvent.data === undefined) {
      return null;
    }

    const rawData = this.currentEvent.data.trim();
    if (!rawData) {
      return null;
    }

    let data: T;
    if (this.options.transform) {
      const transformed = this.options.transform(rawData);
      if (transformed === null) {
        if (this.options.logMalformed) {
          console.warn("SSE transform returned null:", rawData.slice(0, 100));
        }
        return null;
      }
      data = transformed;
    } else {
      try {
        data = JSON.parse(rawData) as T;
      } catch {
        if (this.options.logMalformed) {
          console.warn("SSE parse failed:", rawData.slice(0, 100));
        }
        data = rawData as unknown as T;
      }
    }

    return {
      data,
      rawData,
      eventId: this.currentEvent.id,
      eventType: this.currentEvent.event,
    };
  }
}

/**
 * Parse SSE stream into typed events via async iteration.
 */
export async function* parseSSEStream<T = unknown>(
  stream: ReadableStream<Uint8Array>,
  options: SSEParserOptions<T> = {},
): AsyncGenerator<ParsedSSEEvent<T>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEChunkParser<T>(options);
  let chunkCount = 0;
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(
          `[agent-core:sse] Stream reader done after ${chunkCount} chunks, ${totalBytes} bytes`,
        );
        break;
      }

      chunkCount++;
      totalBytes += value?.length ?? 0;
      const chunk = decoder.decode(value, { stream: true });

      // Log every chunk for debugging
      if (chunkCount <= 3 || chunkCount % 10 === 0) {
        console.log(
          `[agent-core:sse] Chunk ${chunkCount}: ${value?.length ?? 0} bytes, preview: ${chunk.slice(0, 100).replace(/\n/g, "\\n")}`,
        );
      }

      for (const event of parser.push(chunk)) {
        yield event;
      }
    }

    for (const event of parser.flush()) {
      yield event;
    }
  } finally {
    reader.releaseLock();
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
  let eventCount = 0;
  try {
    for await (const event of parseSSEStream<T>(stream, options)) {
      eventCount++;
      onEvent(event);
    }
    // Stream finished normally
    console.log(
      `[agent-core:sse] Stream ended normally, total events: ${eventCount}`,
    );
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    const isAbortError =
      normalizedError.name === "AbortError" ||
      normalizedError.message.toLowerCase().includes("abort");

    if (isAbortError) {
      console.log(
        `[agent-core:sse] Stream aborted normally after ${eventCount} events`,
      );
      onError(normalizedError);
      return;
    }

    console.error(
      `[agent-core:sse] Stream error after ${eventCount} events:`,
      normalizedError,
    );
    onError(normalizedError);
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

/** Event types for tool calls - now handled via message.part.updated */
const _TOOL_CALL_EVENTS = new Set<string>();

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
