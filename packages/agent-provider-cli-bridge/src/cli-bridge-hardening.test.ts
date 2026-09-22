import type {
  AgentEnvironmentEvent,
} from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import {
  captureCliBridgeRunIdentity,
  CliBridgeRunIdentityError,
  readFullCliBridgeResult,
} from "./cli-bridge-client.js";
import { collectCliBridgeTurnResult } from "./cli-bridge-session.js";
import {
  CLI_BRIDGE_MAX_EVENTS,
  CLI_BRIDGE_MAX_RESULT_BYTES,
  CLI_BRIDGE_MAX_RESULT_EVENTS,
  CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
  CLI_BRIDGE_MAX_SSE_FRAME_BYTES,
  CLI_BRIDGE_MAX_TOOL_CALLS,
} from "./cli-bridge-limits.js";
import type {
  CliBridgeProviderOptions,
  CliBridgeRun,
  CliBridgeTransport,
} from "./cli-bridge-types.js";
import { createCliBridgeProvider } from "./index.js";

const baseOptions: CliBridgeProviderOptions = {
  baseUrl: "http://bridge.local",
  defaultModel: "runner/model",
};

describe("CLI Bridge identity and retention hardening", () => {
  it("rejects blank session IDs and generates a durable ID for undefined", async () => {
    let postBody: Record<string, unknown> | undefined;
    const requested: string[] = [];
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url, init) => {
        requested.push(String(url));
        if (init?.method === "GET") {
          const runId = decodeURIComponent(String(url).split("/").at(-1) ?? "");
          return Response.json({ id: runId, status: "running", terminal: false });
        }
        postBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const runId = String(postBody.run_id);
        return streamResponse(runId, "digest", ": connected\n\n");
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const dispatch = environment.dispatch!;

    for (const sessionId of ["", "   "]) {
      await expect(
        dispatch({ prompt: "task", sessionId, executionId: `blank-${sessionId.length}` }),
      ).rejects.toThrow(/non-blank/);
    }
    expect(requested).toHaveLength(0);

    const generated = await dispatch({
      prompt: "task",
      executionId: "generated-session-run",
    });
    expect(generated.id).toBe("generated-session-run");
    expect(postBody?.session_id).toBe(generated.id);
    await expect(environment.session!(generated.id).status()).resolves.toBe("running");

    const explicit = await dispatch({
      prompt: "task",
      sessionId: "explicit-session",
      executionId: "explicit-run",
    });
    expect(explicit.id).toBe("explicit-session");
  });

  it("cancels the authenticated run after an empty live response", async () => {
    const requests: string[] = [];
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url).endsWith("/cancel")) {
          return Response.json({
            run: { id: "empty-live", status: "cancelled", terminal: true },
          });
        }
        return new Response(null, {
          status: 200,
          headers: {
            "x-run-id": "empty-live",
            "x-run-request-digest": "empty-live-digest",
          },
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consume(environment.stream({ prompt: "task", executionId: "empty-live" })),
    ).rejects.toMatchObject({
      name: "CliBridgeProtocolError",
      code: "invalid-body",
    });
    expect(requests.filter((url) => url.endsWith("/cancel"))).toEqual([
      "http://bridge.local/v1/runs/empty-live/cancel",
    ]);
  });

  it("cancels the authenticated run after an empty dispatch response", async () => {
    const requests: string[] = [];
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url).endsWith("/cancel")) {
          return Response.json({
            run: { id: "empty-dispatch", status: "cancelled", terminal: true },
          });
        }
        return new Response(null, {
          status: 200,
          headers: {
            "x-run-id": "empty-dispatch",
            "x-run-request-digest": "empty-dispatch-digest",
          },
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      environment.dispatch!({
        prompt: "task",
        sessionId: "empty-dispatch-session",
        executionId: "empty-dispatch",
      }),
    ).rejects.toMatchObject({
      name: "CliBridgeProtocolError",
      code: "invalid-body",
    });
    expect(requests.filter((url) => url.endsWith("/cancel"))).toEqual([
      "http://bridge.local/v1/runs/empty-dispatch/cancel",
    ]);
  });

  it("does not cancel the requested run after a dispatch identity mismatch", async () => {
    const requests: string[] = [];
    let readerDetached = 0;
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url) => {
        requests.push(String(url));
        return streamResponse("other", "other-digest", ": held\n\n", () => {
          readerDetached += 1;
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const dispatch = environment.dispatch!;

    await expect(
      dispatch({
        prompt: "task",
        sessionId: "wanted-session",
        executionId: "wanted",
      }),
    ).rejects.toBeInstanceOf(CliBridgeRunIdentityError);
    expect(readerDetached).toBe(1);
    expect(requests.some((url) => url.endsWith("/cancel"))).toBe(false);
  });

  it("rejects a dispatch response without the exact run ID before acceptance", async () => {
    const requests: string[] = [];
    let readerDetached = 0;
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url) => {
        requests.push(String(url));
        return responseWithoutRunIdentity(": held\n\n", () => {
          readerDetached += 1;
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      environment.dispatch!({
        prompt: "task",
        sessionId: "missing-dispatch-session",
        executionId: "missing-dispatch",
      }),
    ).rejects.toBeInstanceOf(CliBridgeRunIdentityError);
    expect(readerDetached).toBe(1);
    expect(requests).toEqual(["http://bridge.local/v1/chat/completions"]);
  });

  it("detaches without cancelling after a live-stream identity mismatch", async () => {
    const requests: string[] = [];
    let readerDetached = 0;
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url) => {
        requests.push(String(url));
        return streamResponse("other", "other-digest", ": held\n\n", () => {
          readerDetached += 1;
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consume(environment.stream({ prompt: "task", executionId: "wanted" })),
    ).rejects.toMatchObject({
      name: "CliBridgeRunIdentityError",
      result: { status: "unknown", reason: "response-identity-mismatch" },
    });
    expect(readerDetached).toBe(1);
    expect(requests.some((url) => url.endsWith("/cancel"))).toBe(false);
  });

  it("rejects a live stream without the exact run ID before reading its events", async () => {
    const requests: string[] = [];
    let readerDetached = 0;
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url) => {
        requests.push(String(url));
        return responseWithoutRunIdentity(
          'data: {"choices":[{"delta":{"content":"wrong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          () => {
            readerDetached += 1;
          },
          true,
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consume(environment.stream({ prompt: "task", executionId: "missing-live" })),
    ).rejects.toBeInstanceOf(CliBridgeRunIdentityError);
    expect(readerDetached).toBe(1);
    expect(requests).toEqual(["http://bridge.local/v1/chat/completions"]);
  });

  it("keeps replay identity mismatches detached and action-free after dispatch", async () => {
    const requests: string[] = [];
    let readerDetached = 0;
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url, init) => {
        requests.push(String(url));
        if (init?.method === "POST" && new Headers(init.headers).has("last-event-id")) {
          return streamResponse("other", "other-digest", ": replay\n\n", () => {
            readerDetached += 1;
          });
        }
        return streamResponse("wanted", "wanted-digest", ": dispatch\n\n", () => {
          readerDetached += 1;
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const dispatch = environment.dispatch!;
    const reference = await dispatch({
      prompt: "task",
      sessionId: "wanted-session",
      executionId: "wanted",
    });

    await expect(
      consume(environment.session!(reference.id).events({ since: "0" })),
    ).rejects.toBeInstanceOf(CliBridgeRunIdentityError);
    expect(readerDetached).toBe(2);
    expect(requests.some((url) => url.endsWith("/cancel"))).toBe(false);
  });

  it("rejects a replay response without the exact run ID before the full-result read", async () => {
    const requests: string[] = [];
    let readerDetached = 0;
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url, init) => {
        requests.push(String(url));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream === false) {
          return streamResponse(
            "missing-replay",
            "replay-digest",
            JSON.stringify({
              choices: [{ message: { content: "wrong" }, finish_reason: "stop" }],
            }),
            undefined,
            true,
          );
        }
        return responseWithoutRunIdentity("data: [DONE]\n\n", () => {
          readerDetached += 1;
        }, true);
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consume(
        environment.stream({
          prompt: "task",
          executionId: "missing-replay",
          lastEventId: "1",
        }),
      ),
    ).rejects.toBeInstanceOf(CliBridgeRunIdentityError);
    expect(readerDetached).toBe(1);
    expect(requests).toEqual(["http://bridge.local/v1/chat/completions"]);
  });

  it("keeps full-result identity mismatches detached and action-free", async () => {
    const requests: string[] = [];
    let readerDetached = 0;
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url, init) => {
        requests.push(String(url));
        if (init?.method === "POST" && String(init.body).includes('"stream":false')) {
          return streamResponse(
            "other",
            "other-digest",
            JSON.stringify({
              choices: [{ message: { content: "wrong" }, finish_reason: "stop" }],
            }),
            () => {
              readerDetached += 1;
            },
            true,
          );
        }
        return streamResponse(
          "wanted",
          "wanted-digest",
          'id: 1\ndata: {"choices":[{"delta":{"content":"part"},"finish_reason":"stop"}]}\n\n',
          () => {
            readerDetached += 1;
          },
          true,
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const dispatch = environment.dispatch!;
    const reference = await dispatch({
      prompt: "task",
      sessionId: "wanted-session",
      executionId: "wanted",
    });

    await expect(environment.session!(reference.id).result()).rejects.toBeInstanceOf(
      CliBridgeRunIdentityError,
    );
    expect(readerDetached).toBe(2);
    expect(requests.some((url) => url.endsWith("/cancel"))).toBe(false);
  });

  it("rejects a full-result response without the exact run ID before parsing its body", async () => {
    let readerDetached = 0;
    const run = testRun("missing-full-result");
    const transport: CliBridgeTransport = {
      fetch: async () =>
        responseWithoutRunIdentity(
          JSON.stringify({
            choices: [{ message: { content: "wrong" }, finish_reason: "stop" }],
          }),
          () => {
            readerDetached += 1;
          },
          true,
          "application/json",
        ),
      close: async () => undefined,
    };

    await expect(
      readFullCliBridgeResult(
        baseOptions,
        JSON.stringify({ run_id: run.id }),
        transport,
        undefined,
        undefined,
        (response) => captureCliBridgeRunIdentity(response, run),
      ),
    ).rejects.toBeInstanceOf(CliBridgeRunIdentityError);
    expect(readerDetached).toBe(1);
  });

  it("treats the first request digest as optional and binds it without weakening identity", () => {
    const run = testRun("optional-digest");

    expect(() => captureCliBridgeRunIdentity(new Response(null, {
      headers: { "x-run-id": run.id },
    }), run)).not.toThrow();
    expect(run.requestDigest).toBeUndefined();

    expect(() => captureCliBridgeRunIdentity(new Response(null, {
      headers: {
        "x-run-id": run.id,
        "x-run-request-digest": "digest-1",
      },
    }), run)).not.toThrow();
    expect(run.requestDigest).toBe("digest-1");

    expect(() => captureCliBridgeRunIdentity(new Response(null, {
      headers: { "x-run-id": run.id },
    }), run)).toThrow(CliBridgeRunIdentityError);
    expect(() => captureCliBridgeRunIdentity(new Response(null, {
      headers: {
        "x-run-id": run.id,
        "x-run-request-digest": "digest-2",
      },
    }), run)).toThrow(CliBridgeRunIdentityError);
    expect(() => captureCliBridgeRunIdentity(new Response(null, {
      headers: { "x-run-id": "other" },
    }), run)).toThrow(CliBridgeRunIdentityError);
  });

  it("cancels the exact authenticated run on a bounded live-stream failure", async () => {
    const requests: string[] = [];
    let readerDetached = 0;
    const provider = createCliBridgeProvider({
      ...baseOptions,
      fetch: async (url, init) => {
        requests.push(String(url));
        if (String(url).endsWith("/cancel")) {
          return Response.json({
            run: { id: "bounded-run", status: "cancelled", terminal: true },
          });
        }
        return streamResponse(
          "bounded-run",
          "bounded-digest",
          `data: ${"x".repeat(CLI_BRIDGE_MAX_SSE_FRAME_BYTES + 1)}\n\n`,
          () => {
            readerDetached += 1;
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consume(environment.stream({ prompt: "task", executionId: "bounded-run" })),
    ).rejects.toMatchObject({
      name: "CliBridgeProtocolError",
      code: "frame-bytes",
    });
    expect(readerDetached).toBe(1);
    expect(requests.filter((url) => url.endsWith("/cancel"))).toEqual([
      "http://bridge.local/v1/runs/bounded-run/cancel",
    ]);
  });

  it("compacts cumulative text before retention and bounds result text and bytes", async () => {
    const run = testRun();
    const source = textEvents(128);
    const result = await collectCliBridgeTurnResult(
      source,
      run,
      baseOptions,
      statusTransport(run.id),
      new Map([[run.id, run]]),
      new Map(),
    );
    expect(result.text).toBe("x".repeat(128));
    expect(
      (result.events ?? []).every((event) => {
        const part = event.data.part;
        return (
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          part.text === "x"
        );
      }),
    ).toBe(true);

    for (const size of [
      CLI_BRIDGE_MAX_RESULT_TEXT_BYTES - 1,
      CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
    ]) {
      await expect(
        collectCliBridgeTurnResult(
          singleEvent({ finalText: "x".repeat(size) }),
          testRun(`result-text-${size}`),
          baseOptions,
          statusTransport(`result-text-${size}`),
          new Map(),
          new Map(),
        ),
      ).resolves.toMatchObject({ text: "x".repeat(size) });
    }

    await expect(
      collectCliBridgeTurnResult(
        textEvents(CLI_BRIDGE_MAX_RESULT_EVENTS + 1),
        testRun("result-events"),
        baseOptions,
        statusTransport("result-events"),
        new Map(),
        new Map(),
      ),
    ).rejects.toMatchObject({ code: "result-event-count" });

    await expect(
      collectCliBridgeTurnResult(
        singleEvent({ finalText: "x".repeat(CLI_BRIDGE_MAX_RESULT_TEXT_BYTES + 1) }),
        testRun(),
        baseOptions,
        statusTransport("result-text"),
        new Map(),
        new Map(),
      ),
    ).rejects.toMatchObject({ code: "result-text-bytes" });
    await expect(
      collectCliBridgeTurnResult(
        singleEvent({ blob: "x".repeat(CLI_BRIDGE_MAX_RESULT_BYTES + 1) }),
        testRun(),
        baseOptions,
        statusTransport("result-bytes"),
        new Map(),
        new Map(),
      ),
    ).rejects.toMatchObject({ code: "result-bytes" });
  });

  it("cancels the authenticated run when result retention overflows", async () => {
    const run = testRun("retention-run");
    run.accepted = true;
    let cancellations = 0;
    const transport: CliBridgeTransport = {
      fetch: async (url) => {
        if (url.endsWith("/cancel")) {
          cancellations += 1;
          return Response.json({
            run: { id: run.id, status: "cancelled", terminal: true },
          });
        }
        throw new Error(`unexpected request ${url}`);
      },
      close: async () => undefined,
    };

    await expect(
      collectCliBridgeTurnResult(
        singleEvent({ blob: "x".repeat(CLI_BRIDGE_MAX_RESULT_BYTES + 1) }),
        run,
        baseOptions,
        transport,
        new Map([[run.id, run]]),
        new Map(),
      ),
    ).rejects.toMatchObject({ code: "result-bytes" });
    expect(cancellations).toBe(1);
  });

  it("bounds the full-result response text and detaches its reader", async () => {
    let readerDetached = 0;
    const run = testRun();
    const transport: CliBridgeTransport = {
      fetch: async () =>
        streamResponse(
          run.id,
          "digest-result",
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "x".repeat(CLI_BRIDGE_MAX_RESULT_TEXT_BYTES + 1),
                },
                finish_reason: "stop",
              },
            ],
          }),
          () => {
            readerDetached += 1;
          },
          true,
        ),
      close: async () => undefined,
    };

    await expect(
      readFullCliBridgeResult(
        baseOptions,
        JSON.stringify({ run_id: run.id }),
        transport,
        undefined,
        "session",
        (response) => captureCliBridgeRunIdentity(response, run),
      ),
    ).rejects.toMatchObject({ code: "result-text-bytes" });
    expect(readerDetached).toBe(0);
  });

  it("bounds full-result choices and tool calls", async () => {
    const run = testRun("full-bounds");
    const response = streamResponse(
      run.id,
      "digest-full-bounds",
      JSON.stringify({
        choices: [
          {
            message: {
              content: "ok",
              tool_calls: Array.from(
                { length: CLI_BRIDGE_MAX_TOOL_CALLS + 1 },
                () => ({}),
              ),
            },
            finish_reason: "stop",
          },
        ],
      }),
      undefined,
      true,
    );
    const transport: CliBridgeTransport = {
      fetch: async () => response,
      close: async () => undefined,
    };

    await expect(
      readFullCliBridgeResult(
        baseOptions,
        JSON.stringify({ run_id: run.id }),
        transport,
        undefined,
        "session",
        (accepted) => captureCliBridgeRunIdentity(accepted, run),
      ),
    ).rejects.toMatchObject({ code: "tool-call-count" });

    const manyChoices = streamResponse(
      run.id,
      "digest-full-bounds",
      JSON.stringify({
        choices: Array.from({ length: CLI_BRIDGE_MAX_EVENTS + 1 }, () => ({
          message: { content: "ok" },
          finish_reason: "stop",
        })),
      }),
      undefined,
      true,
    );
    const manyChoiceTransport: CliBridgeTransport = {
      fetch: async () => manyChoices,
      close: async () => undefined,
    };
    await expect(
      readFullCliBridgeResult(
        baseOptions,
        JSON.stringify({ run_id: run.id }),
        manyChoiceTransport,
        undefined,
        "session",
        (accepted) => captureCliBridgeRunIdentity(accepted, run),
      ),
    ).rejects.toMatchObject({ code: "event-count" });
  });
});

async function consume(source: AsyncIterable<AgentEnvironmentEvent>): Promise<void> {
  for await (const _event of source) {
    // Exhaust the stream so reader cleanup and terminal paths execute.
  }
}

function streamResponse(
  runId: string,
  digest: string,
  body: string,
  onCancel?: () => void,
  closeAfterEnqueue = false,
): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        if (closeAfterEnqueue) controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-run-id": runId,
        "x-run-request-digest": digest,
      },
    },
  );
}

function responseWithoutRunIdentity(
  body: string,
  onCancel?: () => void,
  closeAfterEnqueue = false,
  contentType = "text/event-stream",
): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        if (closeAfterEnqueue) controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    { status: 200, headers: { "content-type": contentType } },
  );
}

function testRun(id = "run"): CliBridgeRun {
  return { id, turnId: "turn", requestBody: "{}", readers: new Set() };
}

function statusTransport(id: string): CliBridgeTransport {
  return {
    fetch: async () => Response.json({ id, status: "done", terminal: true }),
    close: async () => undefined,
  };
}

async function* singleEvent(data: Record<string, unknown>): AsyncIterable<AgentEnvironmentEvent> {
  yield { type: "result", data };
}

async function* textEvents(count: number): AsyncIterable<AgentEnvironmentEvent> {
  let text = "";
  for (let index = 0; index < count; index += 1) {
    text += "x";
    const part = {
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "text" as const,
      text,
    };
    yield {
      type: "message.part.updated",
      data: { part, delta: "x" },
      normalized: { type: "message.part.updated", part, delta: "x" },
    };
  }
}
