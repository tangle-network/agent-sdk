/**
 * SSE Parsing Tests
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createStreamUsageExtractor,
  createUsageCallback,
  parseSSEData,
  parseSSEStream,
  SSEChunkParser,
  type StreamUsageExtractor,
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
