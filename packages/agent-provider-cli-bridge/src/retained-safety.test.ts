import { createHash } from "node:crypto";
import type { AgentExactRunControlRef } from "@tangle-network/agent-interface";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "./index.js";

describe("retained cli-bridge safety", () => {
  it("rejects a conflicting control reference before replacing the active session", async () => {
    let calls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { run_id: string };
        return dispatchResponse(body.run_id);
      },
    });
    const environment = await provider.create({
      profile: { name: "worker" },
      idempotencyKey: "environment-1",
    });
    const reference = await environment.dispatch?.({
      prompt: "work",
      sessionId: "session-1",
      executionId: "run-1",
    });
    const original = reference?.controlRef as AgentExactRunControlRef;
    const conflicting: AgentExactRunControlRef = {
      ...original,
      runId: "run-2",
      executionId: "run-2",
      requestDigest: testDigest("run-2"),
    };

    expect(() => environment.session?.("session-1", { controlRef: conflicting })).toThrow(
      "control reference conflicts with the retained run",
    );
    expect(environment.session?.("session-1").controlRef).toEqual(original);
    expect(calls).toBe(1);
  });

  it("rejects a mismatched event execution before network use", async () => {
    let called = false;
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(
      consumeEvents(session.events({ executionId: "another-execution" })),
    ).rejects.toThrow("event request targets another retained execution");
    expect(called).toBe(false);
  });

  it.each(["status", "result", "cancel"] as const)(
    "honors an AbortSignal while waiting for session %s",
    async (operation) => {
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const controlRef = exactControlRef();
      const provider = createCliBridgeProvider({
        baseUrl: "http://bridge.local",
        fetch: async (_url, init) => {
          init?.signal?.throwIfAborted();
          startedResolve();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        },
      });
      const environment = (await provider.get!(controlRef.environmentId))!;
      const session = environment.session!(controlRef.sessionId, { controlRef });
      const controller = new AbortController();
      const pending = operation === "status"
        ? session.status({ signal: controller.signal })
        : operation === "result"
          ? session.result({ signal: controller.signal })
          : session.cancel({ signal: controller.signal });
      await started;

      controller.abort(new DOMException("caller stopped waiting", "AbortError"));

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  it("keeps malformed token totals unknown while retaining an exact model-call count", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: async () => new Response(
        [
          'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"model_requests":2,"prompt_tokens":-1,"completion_tokens":1.5}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events: AgentEnvironmentEvent[] = [];

    for await (const event of environment.stream({ prompt: "work" })) events.push(event);

    expect(events[0]).toMatchObject({
      type: "usage",
      data: { modelRequests: 2 },
    });
    expect(events[0]).not.toHaveProperty("usage");
    expect(events.at(-1)).toMatchObject({
      type: "result",
      data: { finalText: "done", modelRequests: 2 },
    });
  });

  it("rejects a terminal-looking stream without the protocol end marker", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: async () => new Response(
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consumeEvents(environment.stream({ prompt: "work" })),
    ).rejects.toThrow("without the [DONE] protocol marker");
  });
});

async function consumeEvents(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Drain events until the operation ends.
  }
}

function dispatchResponse(runId: string): Response {
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
        "x-run-id": runId,
        "x-run-request-digest": testDigest(runId),
      },
    },
  );
}

function exactControlRef(): AgentExactRunControlRef {
  return {
    runId: "run-1",
    provider: "cli-bridge",
    environmentId: "environment-1",
    sessionId: "session-1",
    executionId: "run-1",
    requestDigest: testDigest("run-1"),
  };
}

function testDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
