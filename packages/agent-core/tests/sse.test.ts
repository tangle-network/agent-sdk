/**
 * SSE conformance: frame parsing and framing (WHATWG §9.2), the JSON
 * event layer, and stream usage extraction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStreamUsageExtractor,
  createUsageCallback,
  encodeSSEFrame,
  parseSSEData,
  parseSSEStream,
  SSEChunkParser,
  SSEFrameParser,
  type StreamUsageExtractor,
  streamSSEFrames,
} from "../src/sse/index.js";

describe("parseSSEData", () => {
  it("should parse event with type and data", () => {
    const raw = 'event: message\ndata: {"text": "hello"}';
    const result = parseSSEData(raw);

    expect(result).toEqual({
      type: "message",
      text: "hello",
    });
  });

  it("should use type from data if no event line", () => {
    const raw =
      'data: {"type": "message.part.updated", "part": {"type": "text"}}';
    const result = parseSSEData(raw);

    expect(result).toEqual({
      type: "message.part.updated",
      part: { type: "text" },
    });
  });

  it("should use data type when both event and data type present", () => {
    // Note: The implementation spreads parsed data over the result,
    // so data.type will override the event line type
    const raw = 'event: custom\ndata: {"type": "other"}';
    const result = parseSSEData(raw);

    expect(result?.type).toBe("other");
  });

  it("should return null for invalid JSON", () => {
    const raw = "data: {invalid json}";
    const result = parseSSEData(raw);

    expect(result).toBeNull();
  });

  it("should return null for empty data", () => {
    const raw = "event: heartbeat";
    const result = parseSSEData(raw);

    expect(result).toBeNull();
  });

  it("should handle multi-line SSE format", () => {
    const raw = 'event: message.delta\ndata: {"tokens": 5}\n\n';
    const result = parseSSEData(raw);

    expect(result).toEqual({
      type: "message.delta",
      tokens: 5,
    });
  });
});

describe("StreamUsageExtractor", () => {
  let extractor: StreamUsageExtractor;

  beforeEach(() => {
    extractor = createStreamUsageExtractor();
  });

  describe("processEvent", () => {
    it("should count text part updates as responses", () => {
      extractor.processEvent({
        type: "message.part.updated",
        part: { type: "text", text: "Hello" },
      });
      extractor.processEvent({
        type: "message.part.updated",
        part: { type: "text", text: "Hello world" },
      });

      const usage = extractor.current();
      expect(usage.responseCount).toBe(2);
    });

    it("should count reasoning part updates as responses", () => {
      extractor.processEvent({
        type: "message.part.updated",
        part: { type: "reasoning", text: "Let me think..." },
      });

      const usage = extractor.current();
      expect(usage.responseCount).toBe(1);
    });

    it("should count tool calls from message.part.updated", () => {
      extractor.processEvent({
        type: "message.part.updated",
        part: { type: "tool", tool: "read_file", id: "call-1" },
      });
      extractor.processEvent({
        type: "message.part.updated",
        part: { type: "tool", tool: "write_file", id: "call-2" },
      });

      const usage = extractor.current();
      expect(usage.toolCallCount).toBe(2);
    });

    it("should extract model ID", () => {
      extractor.processEvent({ type: "message.stop", model: "claude-3-opus" });

      expect(extractor.current().modelId).toBe("claude-3-opus");
    });

    it("should handle Anthropic format tokens from message.stop", () => {
      extractor.processEvent({
        type: "message.stop",
        output_tokens: 10,
        input_tokens: 100,
      });

      const usage = extractor.current();
      expect(usage.usage.outputTokens).toBe(10);
      expect(usage.usage.inputTokens).toBe(100);
    });

    it("should handle usage summary events", () => {
      extractor.processEvent({
        type: "usage",
        usage: {
          input_tokens: 150,
          output_tokens: 50,
          cache_read_input_tokens: 20,
        },
      });

      const usage = extractor.current();
      expect(usage.usage.inputTokens).toBe(150);
      expect(usage.usage.outputTokens).toBe(50);
      expect(usage.usage.cacheReadTokens).toBe(20);
    });

    it("should handle message_stop with usage", () => {
      extractor.processEvent({
        type: "message_stop",
        usage: {
          input_tokens: 200,
          output_tokens: 75,
        },
      });

      const usage = extractor.current();
      expect(usage.usage.inputTokens).toBe(200);
      expect(usage.usage.outputTokens).toBe(75);
    });

    it("should throw if processing after finalize", () => {
      extractor.finalize();

      expect(() => {
        extractor.processEvent({
          type: "message.part.updated",
          part: { type: "text", text: "test" },
        });
      }).toThrow("StreamUsageExtractor already finalized");
    });
  });

  describe("processRawSSE", () => {
    it("should parse and process raw SSE string", () => {
      extractor.processRawSSE(
        'event: message.part.updated\ndata: {"part": {"type": "text", "text": "hello"}}',
      );

      expect(extractor.current().responseCount).toBe(1);
    });

    it("should ignore invalid SSE", () => {
      extractor.processRawSSE("invalid sse data");

      expect(extractor.current().responseCount).toBe(0);
    });
  });

  describe("finalize", () => {
    it("should set durationMs", () => {
      const result = extractor.finalize();

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should return same result on multiple calls", () => {
      const first = extractor.finalize();
      const second = extractor.finalize();

      expect(first).toBe(second);
    });
  });

  describe("reset", () => {
    it("should clear accumulated state", () => {
      extractor.processEvent({
        type: "message.part.updated",
        part: { type: "text", text: "hello" },
      });
      extractor.processEvent({
        type: "message.part.updated",
        part: { type: "tool", tool: "test", id: "call-1" },
      });
      extractor.finalize();

      extractor.reset();

      const usage = extractor.current();
      expect(usage.usage.outputTokens).toBe(0);
      expect(usage.toolCallCount).toBe(0);
      expect(usage.responseCount).toBe(0);
      expect(usage.modelId).toBeUndefined();
    });

    it("should allow processing after reset", () => {
      extractor.finalize();
      extractor.reset();

      expect(() => {
        extractor.processEvent({
          type: "message.part.updated",
          part: { type: "text", text: "test" },
        });
      }).not.toThrow();
    });
  });
});

describe("SSEChunkParser", () => {
  it("parses events across chunk boundaries", () => {
    const parser = new SSEChunkParser();
    const first = parser.push(
      'event: message.part.updated\ndata: {"part":{"type":"text","text":"hi"}}',
    );
    expect(first).toEqual([]);

    const second = parser.push("\n\n");
    expect(second).toHaveLength(1);
    expect(second[0].eventType).toBe("message.part.updated");
    expect(second[0].data).toEqual({ part: { type: "text", text: "hi" } });
  });
});

describe("parseSSEStream", () => {
  it("yields parsed events from a stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: message.part.updated\ndata: {"part":{"type":"text","text":"a"}}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'event: message.part.updated\ndata: {"part":{"type":"text","text":"b"}}\n\n',
          ),
        );
        controller.close();
      },
    });

    const events: Array<{
      type?: string;
      part?: { type: string; text: string };
    }> = [];
    for await (const event of parseSSEStream(stream)) {
      events.push({
        type: event.eventType,
        part: (event.data as { part?: { type: string; text: string } }).part,
      });
    }

    expect(events).toEqual([
      { type: "message.part.updated", part: { type: "text", text: "a" } },
      { type: "message.part.updated", part: { type: "text", text: "b" } },
    ]);
  });
});

describe("createUsageCallback", () => {
  it("should forward events to callback", () => {
    const events: unknown[] = [];
    const { callback } = createUsageCallback((event) => events.push(event));

    callback({
      type: "message.part.updated",
      part: { type: "text", text: "hello" },
    });
    callback({
      type: "message.part.updated",
      part: { type: "text", text: "world" },
    });

    expect(events).toHaveLength(2);
  });

  it("should extract usage from events", () => {
    const { callback, getUsage } = createUsageCallback();

    callback({
      type: "message.part.updated",
      part: { type: "text", text: "hello" },
    });
    callback({
      type: "message.part.updated",
      part: { type: "tool", tool: "test", id: "call-1" },
    });

    const usage = getUsage();
    expect(usage.responseCount).toBe(1);
    expect(usage.toolCallCount).toBe(1);
  });

  it("should work without forward callback", () => {
    const { callback, getUsage } = createUsageCallback();

    expect(() => {
      callback({
        type: "message.part.updated",
        part: { type: "text", text: "test" },
      });
    }).not.toThrow();

    expect(getUsage().responseCount).toBe(1);
  });
});

/** Build a ReadableStream<Uint8Array> that emits the given chunks in order then closes. */
function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function bodyFromString(s: string): ReadableStream<Uint8Array> {
  return bodyFromChunks([s]);
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("SSEFrameParser — framing", () => {
  it("dispatches one frame per blank line", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    expect(frames).toEqual([
      { event: "a", data: "1", id: undefined },
      { event: "b", data: "2", id: undefined },
    ]);
  });

  it("reassembles a frame that straddles chunk boundaries", () => {
    const parser = new SSEFrameParser();
    const wire = 'event: split\ndata: {"taskId":"x"}\n\n';
    const mid = Math.floor(wire.length / 2);
    expect(parser.push(wire.slice(0, mid))).toEqual([]);
    const frames = parser.push(wire.slice(mid));
    expect(frames).toEqual([
      { event: "split", data: '{"taskId":"x"}', id: undefined },
    ]);
  });

  it("holds field state when event: and data: arrive in separate chunks", () => {
    const parser = new SSEFrameParser();
    expect(parser.push("event: two-chunks\n")).toEqual([]);
    const frames = parser.push("data: 1\n\n");
    expect(frames).toEqual([{ event: "two-chunks", data: "1", id: undefined }]);
  });

  it("accepts CRLF terminators", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push("event: crlf\r\ndata: ok\r\n\r\n");
    expect(frames).toEqual([{ event: "crlf", data: "ok", id: undefined }]);
  });

  it("accepts a mix of LF and CRLF frames in one chunk", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push(
      "event: a\ndata: lf\n\nevent: b\r\ndata: crlf\r\n\r\n",
    );
    expect(frames.map((f) => f.data)).toEqual(["lf", "crlf"]);
  });
});

describe("SSEFrameParser — data: field", () => {
  it("joins multi-line data: with \\n (spec §9.2.6)", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push("data: one\ndata: two\ndata: three\n\n");
    expect(frames).toEqual([
      { event: "", data: "one\ntwo\nthree", id: undefined },
    ]);
  });

  it("strips one optional leading space after the colon", () => {
    const parser = new SSEFrameParser();
    expect(parser.push("data: padded\n\n")[0].data).toBe("padded");
    expect(parser.push("data:unpadded\n\n")[0].data).toBe("unpadded");
  });

  it("dispatches a frame whose data: value is empty", () => {
    // A bare `data:` line is still a data field; payload validation is
    // the consumer's decision, not the parser's.
    const parser = new SSEFrameParser();
    expect(parser.push("data:\n\n")).toEqual([
      { event: "", data: "", id: undefined },
    ]);
  });

  it("keeps trailing spaces in the value past the first", () => {
    const parser = new SSEFrameParser();
    expect(parser.push("data:  two-spaces\n\n")[0].data).toBe(" two-spaces");
  });
});

describe("SSEFrameParser — comments and unknown fields", () => {
  it("skips comment lines (heartbeats)", () => {
    const parser = new SSEFrameParser();
    expect(parser.push(": heartbeat\n\n")).toEqual([]);
    const frames = parser.push(": ka\nevent: real\ndata: 1\n\n");
    expect(frames).toEqual([{ event: "real", data: "1", id: undefined }]);
  });

  it("ignores retry: and unrecognized fields", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push("retry: 5000\nfoo: bar\ndata: 1\n\n");
    expect(frames).toEqual([{ event: "", data: "1", id: undefined }]);
  });

  it("drops frames with no data: field and resets their state", () => {
    const parser = new SSEFrameParser();
    expect(parser.push("event: lonely\nid: 9\n\n")).toEqual([]);
    // The consumed event/id must not leak into the next frame.
    expect(parser.push("data: 1\n\n")).toEqual([
      { event: "", data: "1", id: undefined },
    ]);
  });
});

describe("SSEFrameParser — id: field", () => {
  it("surfaces id: and resets it between frames", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push(
      "id: evt-42\nevent: a\ndata: 1\n\nevent: b\ndata: 2\n\n",
    );
    expect(frames[0].id).toBe("evt-42");
    expect(frames[1].id).toBeUndefined();
  });
});

describe("SSEFrameParser — BOM", () => {
  it("strips one leading U+FEFF before the first field line", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push("\uFEFFevent: bom\ndata: 1\n\n");
    expect(frames).toEqual([{ event: "bom", data: "1", id: undefined }]);
  });

  it("strips a BOM that arrives in its own chunk", () => {
    const parser = new SSEFrameParser();
    expect(parser.push("\uFEFF")).toEqual([]);
    const frames = parser.push("data: 1\n\n");
    expect(frames).toEqual([{ event: "", data: "1", id: undefined }]);
  });

  it("does not strip a U+FEFF that is not stream-leading", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push("data: a\uFEFFb\n\n");
    expect(frames[0].data).toBe("a\uFEFFb");
  });
});

describe("SSEFrameParser — flush", () => {
  it("dispatches a dangling frame closed without a blank line", () => {
    const parser = new SSEFrameParser();
    expect(parser.push("event: tail\ndata: last")).toEqual([]);
    expect(parser.flush()).toEqual([
      { event: "tail", data: "last", id: undefined },
    ]);
  });

  it("returns nothing when the stream ended on a frame boundary", () => {
    const parser = new SSEFrameParser();
    parser.push("data: 1\n\n");
    expect(parser.flush()).toEqual([]);
  });
});

describe("SSEFrameParser — retained memory", () => {
  // vitest.config.ts starts the worker with --expose-gc.
  const node = globalThis as unknown as {
    gc?: () => void;
    process: { memoryUsage(): { heapUsed: number } };
  };

  it("keeps no chunk alive through the event names and ids a consumer keeps over a long stream", () => {
    // The Sandbox sidecar restates a whole reasoning part in every `message.part.updated` frame and
    // follows each with a small `model-processing` frame. Agent Runtime keeps every small event of a
    // turn until the turn settles. In V8 a short substring of a long string can be a view that keeps
    // the whole string alive, so a kept event name used to keep its chunk, and with it one copy of
    // the part's text per token. Measured 2026-09-25: about 970 MB of live heap for one 64,000
    // character turn, and lane controllers out of memory near 4 GB (discovery-lab #1098).
    const gc = node.gc;
    if (gc === undefined)
      throw new Error("run with --expose-gc (vitest.config.ts)");
    const parser = new SSEFrameParser();
    const kept: string[] = [];
    const tokens = 3_000;
    gc();
    const before = node.process.memoryUsage().heapUsed;
    let text = "";
    for (let token = 0; token < tokens; token++) {
      text += " one reasoning token";
      const update = JSON.stringify({
        type: "message.part.updated",
        part: { id: "prt_1", type: "reasoning", text },
      });
      const chunk =
        `id: run-7f3a9c2e-${token}-u\nevent: message.part.updated\ndata: ${update}\n\n` +
        `id: run-7f3a9c2e-${token}-p\nevent: model-processing\ndata: {"phase":"thinking"}\n\n`;
      for (const frame of parser.push(chunk)) {
        kept.push(frame.event, frame.id ?? "");
      }
    }
    gc();
    const retainedMb = (node.process.memoryUsage().heapUsed - before) / 2 ** 20;
    expect(kept).toHaveLength(tokens * 4);
    // The stream carried 3,000 restatements of a part that grew to 60,000 characters, about
    // 86 MB of chunks. The kept strings themselves are about 0.3 MB.
    expect(retainedMb).toBeLessThan(8);
  });
});

describe("encodeSSEFrame", () => {
  it("serializes a data-only frame", () => {
    expect(encodeSSEFrame({ data: '{"ok":true}' })).toBe(
      'data: {"ok":true}\n\n',
    );
  });

  it("serializes event, id, and data fields in order", () => {
    expect(encodeSSEFrame({ event: "e", id: "7", data: "x" })).toBe(
      "event: e\nid: 7\ndata: x\n\n",
    );
  });

  it("splits multi-line data into one data: line per source line", () => {
    expect(encodeSSEFrame({ data: "one\ntwo" })).toBe(
      "data: one\ndata: two\n\n",
    );
  });

  it("round-trips through SSEFrameParser", () => {
    const parser = new SSEFrameParser();
    const frames = parser.push(
      encodeSSEFrame({ event: "e", id: "1", data: "one\ntwo" }),
    );
    expect(frames).toEqual([{ event: "e", data: "one\ntwo", id: "1" }]);
  });
});

describe("streamSSEFrames", () => {
  it("throws TypeError when the body is null or undefined", async () => {
    await expect(collect(streamSSEFrames(null))).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(collect(streamSSEFrames(undefined))).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("yields frames in stream order", async () => {
    const frames = await collect(
      streamSSEFrames(
        bodyFromString("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"),
      ),
    );
    expect(frames.map((f) => f.event)).toEqual(["a", "b"]);
  });

  it("keeps a multi-byte character split across chunks intact", async () => {
    // "€" is three UTF-8 bytes; split between byte 1 and 2 of the
    // character. A decoder without { stream: true } would emit U+FFFD.
    const bytes = new TextEncoder().encode("data: €\n\n");
    const splitAt = bytes.indexOf(0xe2) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const frames = await collect(streamSSEFrames(body));
    expect(frames).toEqual([{ event: "", data: "€", id: undefined }]);
  });

  it("flushes a dangling frame at end-of-stream", async () => {
    const frames = await collect(
      streamSSEFrames(bodyFromString("event: tail\ndata: last")),
    );
    expect(frames).toEqual([{ event: "tail", data: "last", id: undefined }]);
  });

  it("cancels the response body when a consumer returns early", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("event: done\ndata: 1\n\n"),
        );
      },
      cancel,
    });
    for await (const frame of streamSSEFrames(body)) {
      expect(frame.event).toBe("done");
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      collect(
        streamSSEFrames(bodyFromString("data: 1\n\n"), { signal: ctrl.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws AbortError when the signal fires mid-stream and the body closes cleanly", async () => {
    const bodyRef: {
      controller?: ReadableStreamDefaultController<Uint8Array>;
    } = {};
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        bodyRef.controller = ctrl;
        ctrl.enqueue(new TextEncoder().encode("event: first\ndata: 0\n\n"));
      },
    });
    const ctrl = new AbortController();
    const iter = streamSSEFrames(body, { signal: ctrl.signal })[
      Symbol.asyncIterator
    ]();
    const first = await iter.next();
    expect(first.value?.event).toBe("first");
    ctrl.abort();
    bodyRef.controller?.close();
    await expect(iter.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});
