import { createServer } from "node:http";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "./index.js";

describe("createCliBridgeProvider", () => {
  it("streams canonical text, tool, usage, and result events", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "codex",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          [
            ": connected\r\n\r\n",
            'data: {"choices":[{"delta":{"content":"hel","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\r\n\r\n',
            'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5,"cost":0.01}}\r\n\r\n',
            "data: [DONE]\r\n\r\n",
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", prompt: { systemPrompt: "system" } },
      backend: "codex",
      workspace: { cwd: "/workspace" },
    });

    const events = [];
    for await (const event of environment.stream({ prompt: "go", sessionId: "s1" })) events.push(event);

    expect(body).toMatchObject({
      model: "codex",
      session_id: "s1",
      cwd: "/workspace",
    });
    expect(events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "message.part.updated",
      "usage",
      "message.part.updated",
      "result",
    ]);
    expect(events[0]).toMatchObject({
      data: {
        delta: "hel",
        part: { type: "text", text: "hel", sessionID: "s1" },
      },
      normalized: {
        type: "message.part.updated",
        delta: "hel",
        part: { type: "text", text: "hel", sessionID: "s1" },
      },
    });
    expect(events[1]).toMatchObject({
      data: {
        part: {
          type: "tool",
          callID: "call-1",
          tool: "read_file",
          state: { status: "pending", input: {} },
        },
      },
    });
    expect(events[2]).toEqual({
      type: "usage",
      data: {},
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        cost: 0.01,
      },
    });
    expect(events[3]).toMatchObject({
      data: { delta: "lo", part: { type: "text", text: "hello" } },
    });
    expect(events.at(-1)).toEqual({
      type: "result",
      data: { finalText: "hello", finishReason: "stop", status: "completed" },
    });
    expect(events.filter((event) => event.data.part && (event.data.part as { type?: string }).type === "tool")).toHaveLength(1);
  });

  it("throws after surfacing a bridge error", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () =>
        new Response('data: {"error":{"message":"harness failed"}}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const iterator = environment.stream({ prompt: "go" })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "status", data: { status: "failed", error: "harness failed" } },
    });
    await expect(iterator.next()).rejects.toThrow("cli-bridge: harness failed");
  });

  it("rejects a stream that ends without a terminal result", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () =>
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    const consume = async () => {
      for await (const _event of environment.stream({ prompt: "go" })) {
        // Drain the stream to its terminal condition.
      }
    };
    await expect(consume()).rejects.toThrow("cli-bridge stream ended without a terminal result");
  });

  it("uses the timeout-free default transport for delayed bridge responses", async () => {
    let connectionCount = 0;
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      }, 25);
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    let environment: AgentEnvironment | undefined;
    try {
      const provider = createCliBridgeProvider({
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      environment = await provider.create({ profile: { name: "worker" } });
      for (let turn = 0; turn < 2; turn += 1) {
        const events = [];
        for await (const event of environment.stream({ prompt: "go" })) events.push(event);
        expect(events.at(-1)).toMatchObject({
          type: "result",
          data: { finalText: "done", status: "completed" },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(connectionCount).toBe(1);

      await environment.destroy?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(sockets.size).toBe(0);
      await expect(environment.status()).resolves.toBe("stopped");
      expect(() => environment?.stream({ prompt: "too late" })).toThrow("cli-bridge environment is destroyed");
      await expect(environment.destroy?.()).resolves.toBeUndefined();
    } finally {
      await environment?.destroy?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("enforces a configured response-header timeout", async () => {
    let delayedResponse: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((_request, response) => {
      delayedResponse = setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"choices":[{"delta":{"content":"late"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      }, 5_000);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const provider = createCliBridgeProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      headersTimeoutMs: 10,
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    try {
      await expect(consume(environment)).rejects.toMatchObject({
        cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
      });
    } finally {
      if (delayedResponse) clearTimeout(delayedResponse);
      await environment.destroy?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("enforces a configured response-body idle timeout", async () => {
    let delayedBody: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
      delayedBody = setTimeout(() => {
        response.end(
          'data: {"choices":[{"delta":{"content":"late"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      }, 5_000);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const provider = createCliBridgeProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      bodyTimeoutMs: 10,
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    try {
      await expect(consume(environment)).rejects.toMatchObject({
        cause: { code: "UND_ERR_BODY_TIMEOUT" },
      });
    } finally {
      if (delayedBody) clearTimeout(delayedBody);
      await environment.destroy?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(
    (["headersTimeoutMs", "bodyTimeoutMs"] as const).flatMap((name) =>
      [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ name, value })),
    ),
  )("rejects invalid $name=$value before execution", ({ name, value }) => {
    expect(() =>
      createCliBridgeProvider({
        baseUrl: "http://bridge.local",
        [name]: value,
      }),
    ).toThrow(`${name} must be a non-negative integer`);
  });
});

async function consume(environment: AgentEnvironment): Promise<void> {
  for await (const _event of environment.stream({ prompt: "go" })) {
    // Drain the stream to its terminal condition.
  }
}
