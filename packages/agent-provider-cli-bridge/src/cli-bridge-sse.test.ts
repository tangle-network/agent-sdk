import { describe, expect, it } from "vitest";
import {
  CLI_BRIDGE_MAX_EVENTS,
  CLI_BRIDGE_MAX_RESPONSE_BYTES,
  CLI_BRIDGE_MAX_SSE_FRAME_BYTES,
  CLI_BRIDGE_MAX_TOOL_CALLS,
  CliBridgeProtocolError,
} from "./cli-bridge-limits.js";
import {
  parseJson,
  parseSse,
  readBoundedUtf8Body,
  toolCallsFromDelta,
} from "./cli-bridge-sse.js";

describe("bounded CLI Bridge protocol readers", () => {
  it("accepts response bytes at N and rejects N+1", async () => {
    for (const size of [
      CLI_BRIDGE_MAX_RESPONSE_BYTES - 1,
      CLI_BRIDGE_MAX_RESPONSE_BYTES,
    ]) {
      await expect(
        readBoundedUtf8Body(oneChunk(new Uint8Array(size))),
      ).resolves.toHaveLength(size);
    }
    await expect(
      readBoundedUtf8Body(oneChunk(new Uint8Array(CLI_BRIDGE_MAX_RESPONSE_BYTES + 1))),
    ).rejects.toMatchObject({
      name: "CliBridgeProtocolError",
      code: "response-bytes",
    });
  });

  it("accepts frame N-1 and N, then rejects frame N+1", async () => {
    for (const size of [
      CLI_BRIDGE_MAX_SSE_FRAME_BYTES - 1,
      CLI_BRIDGE_MAX_SSE_FRAME_BYTES,
    ]) {
      const frame = frameWithBytes(size);
      await expect(collect(parseSse(oneChunk(encode(frame))))).resolves.toHaveLength(1);
    }
    await expect(
      collect(
        parseSse(
          oneChunk(encode(frameWithBytes(CLI_BRIDGE_MAX_SSE_FRAME_BYTES + 1))),
        ),
      ),
    ).rejects.toMatchObject({
      name: "CliBridgeProtocolError",
      code: "frame-bytes",
    });
  });

  it("bounds event and tool-call counts and accepts split UTF-8", async () => {
    const eventBody = Array.from(
      { length: CLI_BRIDGE_MAX_EVENTS },
      () => "data: {}\n\n",
    ).join("");
    await expect(collect(parseSse(oneChunk(encode(eventBody))))).resolves.toHaveLength(
      CLI_BRIDGE_MAX_EVENTS,
    );
    await expect(
      collect(
        parseSse(
          oneChunk(
            encode(
              `${eventBody}data: {}\n\n`,
            ),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "event-count" });

    const emoji = encode("data: 🙂\n\n");
    const split = 8;
    await expect(
      collect(parseSse(chunks([emoji.slice(0, split), emoji.slice(split)]))),
    ).resolves.toEqual([{ data: "🙂" }]);

    const atToolLimit = Array.from(
      { length: CLI_BRIDGE_MAX_TOOL_CALLS },
      (_, index) => ({ index }),
    );
    expect(toolCallsFromDelta({ tool_calls: atToolLimit })).toHaveLength(
      CLI_BRIDGE_MAX_TOOL_CALLS,
    );
    expect(() =>
      toolCallsFromDelta({
        tool_calls: [...atToolLimit, { index: CLI_BRIDGE_MAX_TOOL_CALLS }],
      }),
    ).toThrow(CliBridgeProtocolError);
  });

  it("rejects unterminated, malformed UTF-8, and invalid JSON input", async () => {
    await expect(
      collect(parseSse(oneChunk(encode("x".repeat(CLI_BRIDGE_MAX_SSE_FRAME_BYTES + 1))))),
    ).rejects.toMatchObject({ code: "frame-bytes" });
    await expect(
      collect(parseSse(oneChunk(Uint8Array.from([0x64, 0xff])))),
    ).rejects.toMatchObject({ code: "invalid-utf8" });
    expect(() => parseJson("{" )).toThrow(CliBridgeProtocolError);
  });

  it("stops pulling an unterminated body at the byte bound", async () => {
    let pulls = 0;
    let closed = false;
    const body = (async function* (): AsyncIterable<Uint8Array> {
      try {
        while (true) {
          pulls += 1;
          yield new Uint8Array(1024 * 1024);
        }
      } finally {
        closed = true;
      }
    })();

    await expect(collect(parseSse(body))).rejects.toMatchObject({
      code: "frame-bytes",
    });
    expect(pulls).toBe(2);
    expect(closed).toBe(true);
  });
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

function oneChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  return chunks([value]);
}

async function* chunks(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function frameWithBytes(bytes: number): string {
  const prefix = "data: ";
  return `${prefix}${"x".repeat(bytes - prefix.length)}\n\n`;
}
