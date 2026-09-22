import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import type { TokenUsage } from "@tangle-network/agent-interface";
import type { CliBridgeSseFrame } from "./cli-bridge-types.js";
import {
  addLimit,
  assertLimit,
  CLI_BRIDGE_MAX_DECODED_TEXT_BYTES,
  CLI_BRIDGE_MAX_EVENTS,
  CLI_BRIDGE_MAX_RESPONSE_BYTES,
  CLI_BRIDGE_MAX_SSE_FRAME_BYTES,
  CLI_BRIDGE_MAX_TOOL_CALLS,
  CliBridgeProtocolError,
  utf8Bytes,
} from "./cli-bridge-limits.js";

export async function* parseSse(
  body: AsyncIterable<Uint8Array>,
): AsyncIterable<CliBridgeSseFrame> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let responseBytes = 0;
  let decodedTextBytes = 0;
  let bufferBytes = 0;
  let frameCount = 0;
  for await (const value of body) {
    if (!(value instanceof Uint8Array)) {
      throw new CliBridgeProtocolError("invalid-body", 0, 0);
    }
    responseBytes = addLimit(
      responseBytes,
      value.byteLength,
      CLI_BRIDGE_MAX_RESPONSE_BYTES,
      "response-bytes",
    );
    let decoded: string;
    try {
      decoded = decoder.decode(value, { stream: true });
    } catch {
      throw new CliBridgeProtocolError("invalid-utf8", 0, 0);
    }
    const decodedBytes = utf8Bytes(decoded);
    decodedTextBytes = addLimit(
      decodedTextBytes,
      decodedBytes,
      CLI_BRIDGE_MAX_DECODED_TEXT_BYTES,
      "decoded-text-bytes",
    );
    buffer += decoded;
    bufferBytes += decodedBytes;
    let boundary = findFrameBoundary(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      bufferBytes -= utf8Bytes(frame) + boundary.length;
      assertLimit(
        utf8Bytes(frame),
        CLI_BRIDGE_MAX_SSE_FRAME_BYTES,
        "frame-bytes",
      );
      frameCount = addLimit(
        frameCount,
        1,
        CLI_BRIDGE_MAX_EVENTS,
        "event-count",
      );
      const data = dataFromFrame(frame);
      if (data) yield data;
      boundary = findFrameBoundary(buffer);
    }
    assertLimit(bufferBytes, CLI_BRIDGE_MAX_SSE_FRAME_BYTES, "frame-bytes");
  }
  let tail: string;
  try {
    tail = decoder.decode();
  } catch {
    throw new CliBridgeProtocolError("invalid-utf8", 0, 0);
  }
  if (tail) {
    const tailBytes = utf8Bytes(tail);
    decodedTextBytes = addLimit(
      decodedTextBytes,
      tailBytes,
      CLI_BRIDGE_MAX_DECODED_TEXT_BYTES,
      "decoded-text-bytes",
    );
    buffer += tail;
    bufferBytes += tailBytes;
  }
  if (buffer) {
    assertLimit(bufferBytes, CLI_BRIDGE_MAX_SSE_FRAME_BYTES, "frame-bytes");
    frameCount = addLimit(
      frameCount,
      1,
      CLI_BRIDGE_MAX_EVENTS,
      "event-count",
    );
    const data = dataFromFrame(buffer);
    if (data) yield data;
  }
}

export async function readBoundedUtf8Body(
  body: AsyncIterable<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let responseBytes = 0;
  let decodedTextBytes = 0;
  for await (const value of body) {
    if (!(value instanceof Uint8Array)) {
      throw new CliBridgeProtocolError("invalid-body", 0, 0);
    }
    responseBytes = addLimit(
      responseBytes,
      value.byteLength,
      CLI_BRIDGE_MAX_RESPONSE_BYTES,
      "response-bytes",
    );
    let decoded: string;
    try {
      decoded = decoder.decode(value, { stream: true });
    } catch {
      throw new CliBridgeProtocolError("invalid-utf8", 0, 0);
    }
    decodedTextBytes = addLimit(
      decodedTextBytes,
      utf8Bytes(decoded),
      CLI_BRIDGE_MAX_DECODED_TEXT_BYTES,
      "decoded-text-bytes",
    );
    chunks.push(decoded);
  }
  let tail: string;
  try {
    tail = decoder.decode();
  } catch {
    throw new CliBridgeProtocolError("invalid-utf8", 0, 0);
  }
  decodedTextBytes = addLimit(
    decodedTextBytes,
    utf8Bytes(tail),
    CLI_BRIDGE_MAX_DECODED_TEXT_BYTES,
    "decoded-text-bytes",
  );
  chunks.push(tail);
  return chunks.join("");
}

function findFrameBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function dataFromFrame(frame: string): CliBridgeSseFrame | undefined {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return undefined;
  const id = lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim();
  return { data, ...(id ? { id } : {}) };
}

export function* eventsWithCursor(
  events: readonly AgentEnvironmentEvent[],
  cursor?: string,
): Iterable<AgentEnvironmentEvent> {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    yield cursor && index === events.length - 1
      ? { ...event, id: cursor }
      : event;
  }
}

export function toolCallsFromDelta(value: unknown): Array<{
  id?: string;
  index: number;
  name?: string;
}> {
  if (!value || typeof value !== "object") return [];
  const calls = (value as Record<string, unknown>).tool_calls;
  if (!Array.isArray(calls)) return [];
  assertLimit(calls.length, CLI_BRIDGE_MAX_TOOL_CALLS, "tool-call-count");
  return calls.flatMap((call, position) => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const fn = record.function;
    const name =
      fn &&
      typeof fn === "object" &&
      typeof (fn as Record<string, unknown>).name === "string"
        ? ((fn as Record<string, unknown>).name as string)
        : undefined;
    const index = number(record.index) ?? position;
    const id = typeof record.id === "string" ? record.id : undefined;
    return [{ ...(id ? { id } : {}), index, ...(name ? { name } : {}) }];
  });
}

export function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseJson(value: string): Record<string, unknown> {
  const parsed = safeJson(value);
  if (!parsed) throw new CliBridgeProtocolError("invalid-json", 0, 0);
  return parsed;
}

export function usageFromOpenAi(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = number(record.prompt_tokens) ?? number(record.input_tokens);
  const outputTokens =
    number(record.completion_tokens) ?? number(record.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const totalTokens = number(record.total_tokens);
  const cacheReadInputTokens = number(record.cache_read_input_tokens);
  const cacheCreationInputTokens = number(record.cache_creation_input_tokens);
  const reasoningTokens = number(record.reasoning_tokens);
  const cost = number(record.cost);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
