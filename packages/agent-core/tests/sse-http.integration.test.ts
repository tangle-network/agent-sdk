import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  SSEFrameParser,
  parseSSEStream,
  streamSSEFrames,
} from "../src/sse/index.js";

/** A real TCP peer fragments field prefixes, CRLF, UTF8 and JSON escapes. */
async function peer() {
  let cancelled!: () => void;
  const closed = new Promise<void>((resolve) => (cancelled = resolve));
  const short =
    '\ufeff: heartbeat\r\nevent: answer\r\nid: native-1\r\ndata: {"delta":\r\ndata: "\\u0063🙂"}\r\n\r\nretry: 1000\nunknown: retained\ndata: [DONE]\n\n';
  const prefix = 'data: {"text":"';
  const suffix = '"}\n\n';
  const block = "x".repeat(65536);
  const digest = createHash("sha256").update(prefix);
  for (let n = 0; n < 256; n++) digest.update(block);
  const longHash = digest.update(suffix).digest("hex");
  const server = createServer(async (request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url === "/short") {
      for (const byte of Buffer.from(short))
        response.write(Buffer.from([byte]));
      response.end();
      return;
    }
    response.once("close", () => {
      if (!response.writableFinished) cancelled();
    });
    if (request.url === "/pending") {
      response.write('data: ready\n\ndata: {"pending":"');
      return;
    }
    try {
      for (const part of [
        prefix,
        ...Array.from({ length: 256 }, () => block),
        suffix,
      ]) {
        if (response.destroyed) break;
        if (!response.write(part)) await once(response, "drain");
      }
      response.end();
    } catch {
      response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    short,
    longHash,
    closed,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("shares the wire scanner across actual HTTP frame and JSON-event consumers", async () => {
  const source = await peer();
  try {
    const frames = [];
    for await (const frame of streamSSEFrames(
      (await fetch(`${source.url}/short`)).body,
    ))
      frames.push(frame);
    expect(frames).toEqual([
      { event: "answer", id: "native-1", data: '{"delta":\n"\\u0063🙂"}' },
      { event: "", id: undefined, data: "[DONE]" },
    ]);
    const events = [];
    for await (const event of parseSSEStream(
      (await fetch(`${source.url}/short`)).body!,
    ))
      events.push(event);
    expect(events[0]?.data).toEqual({ delta: "c🙂" });
    expect(events[0]?.eventId).toBe("native-1");
    expect(events[1]?.data).toBe("[DONE]");
  } finally {
    await source.close();
  }
});

it("streams raw fields over real HTTP without retaining the 16MiB data line", async () => {
  const source = await peer();
  try {
    for (const path of ["short", "long"]) {
      const response = await fetch(`${source.url}/${path}`);
      assert.ok(response.body);
      const scanner = new SSEFrameParser();
      const decoder = new TextDecoder();
      const digest = createHash("sha256");
      let largest = 0;
      let bytes = 0;
      const consume = (text: string, final = false) => {
        for (const fragment of scanner.fragments(text, final)) {
          const raw =
            fragment.type === "field"
              ? fragment.prefix
              : fragment.type === "value"
                ? fragment.value
                : fragment.ending;
          largest = Math.max(largest, raw.length);
          bytes += Buffer.byteLength(raw);
          digest.update(raw);
        }
      };
      for await (const chunk of response.body)
        consume(decoder.decode(chunk, { stream: true }));
      consume(decoder.decode(), true);
      expect(digest.digest("hex")).toBe(
        path === "long"
          ? source.longHash
          : createHash("sha256").update(source.short.slice(1)).digest("hex"),
      );
      expect(largest).toBeLessThan(1024 * 1024);
      if (path === "long") expect(bytes).toBeGreaterThan(16 * 1024 * 1024);
    }
  } finally {
    await source.close();
  }
});

it("cancels an unfinished HTTP response when the frame consumer returns early", async () => {
  const source = await peer();
  try {
    const response = await fetch(`${source.url}/pending`);
    for await (const frame of streamSSEFrames(response.body)) {
      expect(frame.data).toBe("ready");
      break;
    }
    await source.closed;
  } finally {
    await source.close();
  }
});

it("propagates abort while waiting for the unfinished next HTTP frame", async () => {
  const source = await peer();
  try {
    const abort = new AbortController();
    const response = await fetch(`${source.url}/pending`, {
      signal: abort.signal,
    });
    const iterator = streamSSEFrames(response.body, { signal: abort.signal });
    expect((await iterator.next()).value?.data).toBe("ready");
    const pending = iterator.next();
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await source.closed;
  } finally {
    await source.close();
  }
});
