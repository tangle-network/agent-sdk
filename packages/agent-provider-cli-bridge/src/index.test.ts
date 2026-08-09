import { createServer } from "node:http";
import type { AgentProfile } from "@tangle-network/agent-interface";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import { createCliBridgeProvider, defaultCliBridgeCapabilities } from "./index.js";

describe("createCliBridgeProvider", () => {
  it("rejects a named profile before network use", async () => {
    let called = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => {
        called = true;
        return new Response();
      },
    });

    await expect(provider.create({ profile: "profile-id" })).rejects.toThrow(
      /requires an inline AgentProfile/,
    );
    expect(called).toBe(false);
  });

  it("keeps profile authority separate from the task and forwards it unchanged", async () => {
    let body: Record<string, unknown> | undefined;
    const profile: AgentProfile = {
      name: "scientist",
      harness: "pi",
      model: {
        provider: "tangle-router",
        default: "glm-5.2",
        reasoningEffort: "xhigh",
      },
      prompt: { systemPrompt: "Use this system prompt exactly once." },
      mcp: {
        coordination: {
          transport: "http",
          url: "http://127.0.0.1:4444/mcp",
        },
      },
    };
    const expectedProfile = structuredClone(profile);
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const environment = await provider.create({ profile });
    await expect(environment.session?.("missing").status()).resolves.toBeNull();
    profile.prompt!.systemPrompt = "Caller mutation must not cross intake.";
    profile.model!.default = "different-model";

    await consumeTurn(environment, {
      prompt: "run the task",
      sessionId: "profile-session",
      turnId: "profile-turn",
      executionId: "profile-run",
    });

    expect(body).toMatchObject({
      model: "pi/tangle-router/glm-5.2",
      effort: "xhigh",
      messages: [{ role: "user", content: "run the task" }],
    });
    expect(body?.agent_profile).toEqual(expectedProfile);
  });

  it("maps durable dispatch, replay, result, and continuation into one exact session", async () => {
    const profile: AgentProfile = {
      name: "research-leader",
      harness: "pi",
      model: {
        provider: "tangle-router",
        default: "glm-5.2",
        reasoningEffort: "high",
      },
      prompt: { systemPrompt: "Lead the research." },
    };
    const requests: Array<{
      body: Record<string, unknown>;
      cursor: string | null;
    }> = [];
    const statuses = new Map<string, "running" | "done">();
    let dispatchReaderDetached = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url, init) => {
        const target = String(url);
        if (init?.method === "GET") {
          const runId = decodeURIComponent(target.split("/").at(-1)?.split("?")[0] ?? "");
          const status = statuses.get(runId) ?? "running";
          return runResponse(runId, status, status === "done");
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const runId = String(body.run_id);
        const cursor = new Headers(init?.headers).get("last-event-id");
        requests.push({ body, cursor });
        const headers = {
          "content-type": "text/event-stream",
          "x-run-id": runId,
          "x-run-request-digest": `digest-${runId}`,
        };
        if (body.stream === false) {
          return Response.json(
            {
              choices: [{
                message: { role: "assistant", content: `complete-${runId}` },
                finish_reason: "stop",
              }],
              usage: {
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18,
                reasoning_tokens: 3,
                cost: 0.04,
              },
            },
            {
              headers: {
                "x-run-id": runId,
                "x-run-request-digest": `digest-${runId}`,
              },
            },
          );
        }
        if (cursor !== null) {
          statuses.set(runId, "done");
          return new Response(
            [
              `id: 2\ndata: {"choices":[{"delta":{"content":"replayed-${runId}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"reasoning_tokens":3,"cost":0.04}}\n\n`,
              "data: [DONE]\n\n",
            ].join(""),
            { status: 200, headers },
          );
        }
        if (runId === "run-2") {
          statuses.set(runId, "done");
          return new Response(
            `id: 1\ndata: {"choices":[{"delta":{"content":"continued"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"cost":0.01}}\n\ndata: [DONE]\n\n`,
            { status: 200, headers },
          );
        }
        statuses.set(runId, "running");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
            cancel() {
              dispatchReaderDetached = true;
            },
          }),
          { status: 200, headers },
        );
      },
    });
    const environment = await provider.create({ profile });

    const reference = await environment.dispatch?.({
      prompt: "initial task",
      sessionId: "research-session",
      turnId: "turn-1",
      executionId: "run-1",
    });

    expect(reference).toEqual({
      id: "research-session",
      provider: "cli-bridge",
      metadata: {
        runId: "run-1",
        requestDigest: "digest-run-1",
      },
    });
    expect(dispatchReaderDetached).toBe(true);
    const session = environment.session?.(reference!.id);
    await expect(session?.status()).resolves.toBe("running");
    const replayed = [];
    for await (const event of session!.events({ since: "1" })) replayed.push(event);
    expect(replayed.map((event) => event.type)).toEqual([
      "usage",
      "message.part.updated",
      "result",
    ]);
    expect(replayed[0]?.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      reasoningTokens: 3,
      cost: 0.04,
    });
    expect(replayed.at(-1)).toMatchObject({
      id: "2",
      data: {
        finalText: "complete-run-1",
        status: "completed",
      },
    });
    await expect(session?.result()).resolves.toMatchObject({
      text: "complete-run-1",
      success: true,
      sessionId: "research-session",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        reasoningTokens: 3,
        cost: 0.04,
      },
      metadata: {
        runId: "run-1",
        status: "done",
        requestDigest: "digest-run-1",
      },
    });
    await expect(session?.prompt({
      prompt: "new direction",
      turnId: "turn-2",
      executionId: "run-2",
    })).resolves.toMatchObject({
      text: "continued",
      success: true,
      sessionId: "research-session",
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cost: 0.01,
      },
      metadata: { runId: "run-2", status: "done" },
    });
    await expect(session?.prompt({
      prompt: "wrong conversation",
      sessionId: "other-session",
    })).rejects.toThrow(/cannot prompt session/);

    const wireBodies = requests
      .filter(({ body }) => body.stream !== false)
      .map(({ body }) => body);
    expect(wireBodies).toEqual([
      expect.objectContaining({
        run_id: "run-1",
        session_id: "research-session",
        agent_profile: profile,
        messages: [{ role: "user", content: "initial task" }],
      }),
      expect.objectContaining({
        run_id: "run-1",
        session_id: "research-session",
        agent_profile: profile,
        messages: [{ role: "user", content: "initial task" }],
      }),
      expect.objectContaining({
        run_id: "run-1",
        session_id: "research-session",
        agent_profile: profile,
        messages: [{ role: "user", content: "initial task" }],
      }),
      expect.objectContaining({
        run_id: "run-2",
        session_id: "research-session",
        agent_profile: profile,
        messages: [{ role: "user", content: "new direction" }],
      }),
    ]);
    expect(requests.filter(({ body }) => body.stream !== false).map(({ cursor }) => cursor))
      .toEqual([null, "1", "0", null]);
    for (const { body } of requests) {
      expect(body.messages).not.toEqual(
        expect.arrayContaining([{ role: "system", content: "Lead the research." }]),
      );
    }
    expect(provider.capabilities()).toMatchObject({
      streaming: { detach: true, replay: true },
      sessions: { continue: true },
    });
  });

  it("waits for terminal proof when cancelling a dispatched session", async () => {
    const requested: string[] = [];
    let getCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        const target = String(url);
        requested.push(target);
        if (target.endsWith("/cancel")) {
          return cancelResponse("cancel-run", "running", false, 202);
        }
        if (init?.method === "GET") {
          getCalls += 1;
          return runResponse(
            "cancel-run",
            getCalls === 1 ? "running" : "cancelled",
            getCalls > 1,
          );
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-run-id": "cancel-run",
              "x-run-request-digest": "cancel-digest",
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const reference = await environment.dispatch?.({
      prompt: "long task",
      sessionId: "cancel-session",
      executionId: "cancel-run",
    });

    await environment.session?.(reference!.id).cancel();

    expect(requested).toContain(
      "http://bridge.local/v1/runs/cancel-run/cancel",
    );
    expect(requested).toContain(
      "http://bridge.local/v1/runs/cancel-run?wait_ms=30000",
    );
    expect(getCalls).toBe(2);
  });

  it("rejects replay when the bridge changes a bound request digest", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const runId = String(body.run_id);
        const replay = new Headers(init?.headers).has("last-event-id");
        return new Response(
          replay
            ? 'data: {"choices":[{"delta":{"content":"wrong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            : new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(": connected\n\n"));
                },
              }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-run-id": runId,
              "x-run-request-digest": replay ? "changed-digest" : "original-digest",
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const reference = await environment.dispatch?.({
      prompt: "task",
      sessionId: "digest-session",
      executionId: "digest-run",
    });

    await expect(
      consumeEvents(environment.session!(reference!.id).events({ since: "0" })),
    ).rejects.toThrow(/changed request digest/);
  });

  it("keeps concurrent continuation results bound to their own run identity", async () => {
    const statuses = new Map<string, "running" | "done">();
    let releaseFirst: (() => void) | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          const runId = decodeURIComponent(
            String(url).split("/").at(-1)?.split("?")[0] ?? "",
          );
          const status = statuses.get(runId) ?? "running";
          return runResponse(runId, status, status === "done");
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const runId = String(body.run_id);
        statuses.set(runId, "running");
        const headers = {
          "content-type": "text/event-stream",
          "x-run-id": runId,
          "x-run-request-digest": `digest-${runId}`,
        };
        if (runId === "concurrent-a") {
          return new Response(
            new ReadableStream({
              start(controller) {
                releaseFirst = () => {
                  statuses.set(runId, "done");
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"choices":[{"delta":{"content":"first"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                    ),
                  );
                  controller.close();
                };
              },
            }),
            { status: 200, headers },
          );
        }
        statuses.set(runId, "done");
        return new Response(
          'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const session = environment.session!("concurrent-session");
    const first = session.prompt({
      prompt: "first",
      executionId: "concurrent-a",
    });
    while (!releaseFirst) await Promise.resolve();
    const second = await session.prompt({
      prompt: "second",
      executionId: "concurrent-b",
    });
    releaseFirst();
    const firstResult = await first;

    expect(firstResult).toMatchObject({
      text: "first",
      metadata: { runId: "concurrent-a", status: "done" },
    });
    expect(second).toMatchObject({
      text: "second",
      metadata: { runId: "concurrent-b", status: "done" },
    });
  });

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
      defaultModel: "opencode",
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
      defaultModel: "opencode",
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
        defaultModel: "opencode",
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

      const lazy = environment.stream({ prompt: "too late" });
      await environment.destroy?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(sockets.size).toBe(0);
      await expect(environment.status()).resolves.toBe("stopped");
      await expect(consumeEvents(lazy)).rejects.toThrow(
        "cli-bridge environment is destroyed",
      );
      expect(connectionCount).toBe(1);
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
    const server = createServer((request, response) => {
      const runId = decodeURIComponent(
        request.url?.split("/")[3]?.split("?")[0] ?? "",
      );
      if (request.url?.endsWith("/cancel")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            cancelled: true,
            cancel_requested: true,
            terminal: true,
            run: { id: runId, status: "cancelled", terminal: true },
          }),
        );
        return;
      }
      if (request.url?.startsWith("/v1/runs/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: runId,
          status: "running",
          terminal: false,
        }));
        return;
      }
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
      defaultModel: "opencode",
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
    const server = createServer((request, response) => {
      const runId = decodeURIComponent(
        request.url?.split("/")[3]?.split("?")[0] ?? "",
      );
      if (request.url?.endsWith("/cancel")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            cancelled: true,
            cancel_requested: true,
            terminal: true,
            run: { id: runId, status: "cancelled", terminal: true },
          }),
        );
        return;
      }
      if (request.url?.startsWith("/v1/runs/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: runId,
          status: "running",
          terminal: false,
        }));
        return;
      }
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
      defaultModel: "opencode",
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
    (["headersTimeoutMs", "bodyTimeoutMs", "cancelWaitMs"] as const).flatMap((name) =>
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

  it("continues one bridge-owned session with profile-selected harness, provider, and model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const answers = new Map<string, string>();
    let lastRunId = "";
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          return runResponse(lastRunId, "done", true);
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const runId = String(body.run_id);
        lastRunId = runId;
        let answer = answers.get(runId);
        if (!answer) {
          bodies.push(body);
          answer = `answer-${bodies.length}`;
          answers.set(runId, answer);
        }
        return new Response(
          [
            `id: 1\ndata: {"choices":[{"delta":{"content":"${answer}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const environment = await provider.create({
      profile: {
        name: "scientist",
        harness: "pi",
        model: { provider: "tangle-router", default: "glm-5.2" },
      },
    });

    await consumeTurn(environment, {
      prompt: "first",
      sessionId: "session-1",
      model: "glm-5.2",
      turnId: "turn-1",
      executionId: "run-1",
    });
    await consumeTurn(environment, {
      prompt: "second",
      sessionId: "session-1",
      model: "tangle-router/glm-5.2",
      turnId: "turn-2",
      executionId: "run-2",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies).toEqual([
      expect.objectContaining({
        model: "pi/tangle-router/glm-5.2",
        session_id: "session-1",
        run_id: "run-1",
      }),
      expect.objectContaining({
        model: "pi/tangle-router/glm-5.2",
        session_id: "session-1",
        run_id: "run-2",
      }),
    ]);
    expect(provider.capabilities()).toMatchObject({ streaming: { replay: true } });
  });

  it("waits through a 202 cancellation when a caller stops reading", async () => {
    let status: "running" | "cancelled" = "running";
    let getCalls = 0;
    const requested: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: async (url, init) => {
        requested.push(String(url));
        if (init?.method === "GET") {
          getCalls += 1;
          if (getCalls === 1) {
            return runResponse("run-reader-stop", "running", false);
          }
          status = "cancelled";
          return runResponse("run-reader-stop", status, true);
        }
        if (String(url).endsWith("/cancel")) {
          return cancelResponse("run-reader-stop", "running", false, 202);
        }
        return new Response(
          [
            'id: 1\ndata: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            'id: 2\ndata: {"choices":[{"delta":{"content":"unused"},"finish_reason":"stop"}]}\n\n',
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const iterator = environment.stream({
      prompt: "work",
      sessionId: "reader-stop",
      executionId: "run-reader-stop",
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "message.part.updated", id: "1" },
    });
    await iterator.return?.();

    expect(requested).toContain("http://bridge.local/v1/runs/run-reader-stop/cancel");
    expect(requested).toContain(
      "http://bridge.local/v1/runs/run-reader-stop?wait_ms=30000",
    );
    expect(getCalls).toBe(2);
  });

  it("keeps an environment retryable when cancellation is not confirmed", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let cancelCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        if (String(url).endsWith("/cancel")) {
          cancelCalls += 1;
          if (cancelCalls === 1) {
            return new Response('{"error":{"message":"temporary failure"}}', {
              status: 503,
            });
          }
          return cancelResponse("retryable-run", "cancelled", true);
        }
        if (init?.method === "GET") {
          return runResponse("retryable-run", "running", false);
        }
        startedResolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const running = consumeTurn(environment, {
      prompt: "long work",
      executionId: "retryable-run",
    });
    await started;

    await expect(environment.destroy?.()).rejects.toThrow("cli-bridge cancel 503");
    await expect(environment.status()).resolves.toBe("running");
    await environment.destroy?.();
    await expect(running).rejects.toThrow("cli-bridge run ended cancelled");
    expect(cancelCalls).toBe(2);
  });

  it("cancels an active sessionless run before destroying its transport", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const requested: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: async (url, init) => {
        requested.push(String(url));
        if (String(url).endsWith("/cancel")) {
          return cancelResponse("run-no-session", "cancelled", true);
        }
        if (init?.method === "GET") {
          return runResponse("run-no-session", "cancelled", true);
        }
        startedResolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const running = consumeTurn(environment, {
      prompt: "long work",
      executionId: "run-no-session",
    });
    await started;

    await environment.destroy?.();
    await expect(running).rejects.toThrow("cli-bridge run ended cancelled");
    expect(requested).toContain("http://bridge.local/v1/runs/run-no-session/cancel");
  });

  it("isolates derived run ids across environments and keeps them wire-safe", async () => {
    const runIds: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        runIds.push(String(body.run_id));
        return terminalResponse("ok");
      },
    });
    const first = await provider.create({ profile: { name: "same-name" } });
    const second = await provider.create({ profile: { name: "same-name" } });

    await consumeTurn(first, { prompt: "same", turnId: "turn-1" });
    await consumeTurn(second, { prompt: "same", turnId: "turn-1" });

    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
    for (const runId of runIds) {
      expect(runId.length).toBeLessThanOrEqual(128);
      expect(runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
    }
  });

  it("hashes an unsafe execution id deterministically", async () => {
    const runIds: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        runIds.push(String(body.run_id));
        return terminalResponse("ok");
      },
    });
    const environment = await provider.create({
      profile: { name: "worker" },
      idempotencyKey: "environment-1",
    });
    const unsafe = `${"not/wire safe ".repeat(20)}!`;

    await consumeTurn(environment, { prompt: "same", executionId: unsafe });
    await consumeTurn(environment, { prompt: "same", executionId: unsafe });

    expect(runIds[0]).toBe(runIds[1]);
    expect(runIds[0]).toMatch(/^agent-[a-f0-9]{64}$/u);
  });

  it("reattaches after a reader failure using the server event cursor", async () => {
    let chatCalls = 0;
    let aggregateCalls = 0;
    let status: "running" | "done" = "running";
    let replayCursor: string | null = null;
    const encoder = new TextEncoder();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: async (_url, init) => {
        if (init?.method === "GET") return runResponse("run-replay", status, status === "done");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream === false) {
          aggregateCalls += 1;
          return Response.json({
            choices: [{
              message: { role: "assistant", content: "partial complete" },
              finish_reason: "stop",
            }],
          });
        }
        chatCalls += 1;
        if (chatCalls === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'id: 1\ndata: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
                  ),
                );
                controller.error(new Error("reader disconnected"));
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        replayCursor = new Headers(init?.headers).get("last-event-id");
        status = "done";
        return new Response(
          'id: 2\ndata: {"choices":[{"delta":{"content":" complete"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consumeTurn(environment, {
        prompt: "work",
        sessionId: "replay",
        executionId: "run-replay",
      }),
    ).rejects.toThrow("reader disconnected");
    const replayed = [];
    for await (const event of environment.stream({
      prompt: "work",
      sessionId: "replay",
      executionId: "run-replay",
      lastEventId: "1",
    })) replayed.push(event);

    expect(replayCursor).toBe("1");
    expect(replayed.at(-1)).toMatchObject({
      type: "result",
      id: "2",
      data: { finalText: "partial complete" },
    });
    expect(aggregateCalls).toBe(1);
  });

  it("reads the full result when replay starts after the terminal event", async () => {
    let aggregateCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream === false) {
          aggregateCalls += 1;
          return Response.json({
            choices: [{
              message: { role: "assistant", content: "already complete" },
              finish_reason: "stop",
            }],
          });
        }
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events = [];

    for await (const event of environment.stream({
      prompt: "work",
      executionId: "terminal-replay",
      lastEventId: "3",
    })) events.push(event);

    expect(events).toEqual([{
      type: "result",
      id: "3",
      data: {
        finalText: "already complete",
        finishReason: "stop",
        status: "completed",
      },
    }]);
    expect(aggregateCalls).toBe(1);
  });

  it("does not claim or cancel a run id rejected by the bridge", async () => {
    let cancelCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        if (String(url).endsWith("/cancel")) {
          cancelCalls += 1;
          return cancelResponse("shared-run", "cancelled", true);
        }
        if (init?.method === "GET") {
          return runResponse("shared-run", "running", false);
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("response body failed"));
            },
          }),
          { status: 409 },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(consumeTurn(environment, {
      prompt: "conflicting work",
      executionId: "shared-run",
    })).rejects.toThrow("cli-bridge 409");
    await environment.destroy?.();

    expect(cancelCalls).toBe(0);
  });

  it("refuses execution when no run data selects a model or harness", async () => {
    let called = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(consume(environment)).rejects.toThrow(
      "requires an explicit bridge model or a profile/backend harness",
    );
    expect(called).toBe(false);
  });

  it("uses a provider-qualified turn model instead of the profile provider", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return terminalResponse("ok");
      },
    });
    const environment = await provider.create({
      backend: "runner",
      profile: {
        name: "worker",
        model: { provider: "preferred", default: "base" },
      },
    });

    await consumeTurn(environment, {
      prompt: "work",
      model: "override/model",
    });

    expect(body?.model).toBe("runner/override/model");
  });

  it("sends both prompt intents through agent_profile and synthesizes no system message", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return terminalResponse("ok");
      },
    });
    const environment = await provider.create({
      backend: "claude-code",
      profile: {
        name: "worker",
        prompt: {
          systemPrompt: "REPLACEMENT_ONLY",
          appendSystemPrompt: "ADDITION_ONLY",
          instructions: ["PROJECT_INSTRUCTION"],
        },
      },
    });

    await consumeTurn(environment, { prompt: "go" });

    // Both intents travel intact on agent_profile, where the bridge binds each to the control its
    // harness owns (claude-code: --system-prompt / --append-system-prompt) or refuses it.
    expect(
      (body?.agent_profile as { prompt?: Record<string, unknown> } | undefined)?.prompt,
    ).toEqual({
      systemPrompt: "REPLACEMENT_ONLY",
      appendSystemPrompt: "ADDITION_ONLY",
      instructions: ["PROJECT_INSTRUCTION"],
    });
    // The turn carries the user turn and nothing else. A synthesized `role: "system"` message would
    // (a) lower the REPLACEMENT intent as an ADDITION, and (b) make the bridge reject the whole
    // request, which refuses system-role messages beside agent_profile.
    expect(body?.messages).toEqual([{ role: "user", content: "go" }]);
    const roles = (body?.messages as Array<{ role: string }>).map((message) => message.role);
    expect(roles).not.toContain("system");
    expect(JSON.stringify(body?.messages)).not.toContain("REPLACEMENT_ONLY");
    expect(JSON.stringify(body?.messages)).not.toContain("ADDITION_ONLY");
  });

  it("declares the prompt intents of the named bridge harness, and neither without one", () => {
    // The adapter forwards agent_profile; the intents belong to the harness the bridge runs. Being
    // able to put the field on the wire is not honoring it, so an unnamed harness declares neither.
    expect(defaultCliBridgeCapabilities("claude-code").profile.systemPrompt).toEqual({
      replace: true,
      append: true,
    });
    expect(defaultCliBridgeCapabilities("opencode").profile.systemPrompt).toEqual({
      replace: false,
      append: true,
    });
    expect(defaultCliBridgeCapabilities("codex").profile.systemPrompt).toEqual({
      replace: true,
      append: false,
    });
    expect(defaultCliBridgeCapabilities("acp").profile.systemPrompt).toEqual({
      replace: false,
      append: false,
    });
    expect(defaultCliBridgeCapabilities().profile.systemPrompt).toEqual({
      replace: false,
      append: false,
    });
  });
});

async function consume(environment: AgentEnvironment): Promise<void> {
  for await (const _event of environment.stream({ prompt: "go" })) {
    // Drain the stream to its terminal condition.
  }
}

async function consumeTurn(
  environment: AgentEnvironment,
  turn: Parameters<AgentEnvironment["stream"]>[0],
): Promise<void> {
  await consumeEvents(environment.stream(turn));
}

async function consumeEvents(
  events: AsyncIterable<unknown>,
): Promise<void> {
  for await (const _event of events) {
    // Drain the stream to its terminal condition.
  }
}

function terminalResponse(text: string): Response {
  return new Response(
    `data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function runResponse(
  id: string,
  status: "running" | "done" | "error" | "cancelled",
  terminal: boolean,
): Response {
  return new Response(JSON.stringify({ id, status, terminal }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function cancelResponse(
  id: string,
  status: "running" | "done" | "error" | "cancelled",
  terminal: boolean,
  responseStatus = 200,
): Response {
  return new Response(
    JSON.stringify({
      cancelled: status === "cancelled",
      cancel_requested: true,
      terminal,
      run: { id, status, terminal },
    }),
    {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    },
  );
}
