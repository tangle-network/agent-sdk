/**
 * A retained turn whose first observation failed is reattached by the next attempt in the same
 * process (tangle-network/agent-sdk#812). Runtime's replacement attempt reads the environment
 * through `get(id)`, binds it to its retained key from `metadata.retainedIdempotencyKey`, and
 * dispatches the same turn identity, which the Bridge answers with the run it already holds.
 * The provider runs unchanged against a loopback peer speaking the Bridge's retained HTTP
 * protocol: dispatch with replay, replayable run events and exact run status.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentExactRunControlRef } from "@tangle-network/agent-interface";
import {
  createCliBridgeProvider,
  defaultCliBridgeCapabilities,
} from "@tangle-network/agent-provider-cli-bridge";
import { describe, expect, it } from "vitest";

const MODEL = "claude-code/anthropic/fixture-model";
const profile = {
  name: "long-turn-worker",
  harness: "claude-code" as const,
  model: { provider: "anthropic", default: "fixture-model" },
  prompt: { systemPrompt: "Run the long native turn fixture." },
};

/** The fields Runtime's retained dispatch sends: a stable turn, session and execution. */
function retainedTurn(name: string) {
  return {
    prompt: "Run the long native turn.",
    turnId: `${name}:turn:0`,
    sessionId: `retained-session-${name}`,
    executionId: `retained-execution-${name}`,
    detach: true,
  } as const;
}

interface BridgeRun {
  readonly requestDigest: string;
  readonly headers: Record<string, string>;
  readonly snapshot: Record<string, string>;
  readonly frames: string[];
  status: "running" | "done";
  readonly waiters: Set<() => void>;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return JSON.stringify({
    id: "chatcmpl-retained-fixture",
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/**
 * A new run id starts one native turn that settles `turnMs` later whether or not anyone reads
 * it, as a detached Bridge run does. The same run id with the same request replays that run.
 */
async function startRetainedBridge(turnMs: number) {
  const runs = new Map<string, BridgeRun>();
  const nativeTurns: string[] = [];
  const replays: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const notify = (run: BridgeRun) => {
    for (const waiter of [...run.waiters]) waiter();
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://bridge.local");
    if (req.method === "GET" && url.pathname === "/v1/capabilities") {
      return json(res, 200, defaultCliBridgeCapabilities("claude-code"));
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString("utf8")) as Record<string, string>;
      const runId = body.run_id!;
      const requestDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      const existing = runs.get(runId);
      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) {
          return json(res, 409, { error: { message: "run id belongs to another request" } });
        }
        replays.push(runId);
        res.writeHead(200, { ...existing.headers, "content-type": "text/event-stream" });
        res.flushHeaders();
        return;
      }
      const run: BridgeRun = {
        requestDigest,
        headers: {
          "x-run-id": runId,
          "x-run-request-digest": requestDigest,
          "x-run-provider": body.provider!,
          "x-run-environment-id": body.environment_id!,
          "x-run-session-id": body.session_id!,
          "x-run-execution-id": body.execution_id!,
        },
        snapshot: {
          id: runId,
          requestDigest,
          provider: body.provider!,
          environmentId: body.environment_id!,
          sessionId: body.session_id!,
          executionId: body.execution_id!,
        },
        frames: [chunk({ role: "assistant", content: "native turn " }, null)],
        status: "running",
        waiters: new Set(),
      };
      runs.set(runId, run);
      nativeTurns.push(runId);
      const timer = setTimeout(() => {
        timers.delete(timer);
        run.frames.push(chunk({ content: "settled after a reattach" }, null), chunk({}, "stop"));
        run.status = "done";
        notify(run);
      }, turnMs);
      timers.add(timer);
      res.writeHead(200, { ...run.headers, "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    const events = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/u)?.[1];
    if (req.method === "GET" && events !== undefined) {
      const run = runs.get(decodeURIComponent(events));
      if (!run) return json(res, 404, { error: { message: "run not found" } });
      res.writeHead(200, { ...run.headers, "content-type": "text/event-stream" });
      let sent = Number(req.headers["last-event-id"] ?? 0);
      const flush = () => {
        while (sent < run.frames.length) {
          sent += 1;
          res.write(`id: ${sent}\ndata: ${run.frames[sent - 1]}\n\n`);
        }
        if (run.status === "running") return;
        run.waiters.delete(flush);
        res.end("data: [DONE]\n\n");
      };
      run.waiters.add(flush);
      res.on("close", () => run.waiters.delete(flush));
      flush();
      return;
    }
    const status = url.pathname.match(/^\/v1\/runs\/([^/]+)$/u)?.[1];
    if (req.method === "GET" && status !== undefined) {
      const run = runs.get(decodeURIComponent(status));
      if (!run) return json(res, 404, { error: { message: "run not found" } });
      const waitMs = Number(url.searchParams.get("wait_ms") ?? 0);
      if (run.status === "running" && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            run.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          run.waiters.add(done);
        });
      }
      return json(res, 200, {
        ...run.snapshot,
        status: run.status,
        terminal: run.status !== "running",
      });
    }
    json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    nativeTurns,
    replays,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("retained CLI Bridge reattachment", () => {
  it("reattaches a turn whose first observation was aborted and settles its exact result once", async () => {
    const bridge = await startRetainedBridge(3_000);
    try {
      const key = "runtime:retained-reattach";
      const turn = retainedTurn("reattach");
      const provider = createCliBridgeProvider({ baseUrl: bridge.url, defaultModel: MODEL });
      await provider.capabilities();
      // Runtime 10.0.12 gave create a 120 s timer that this provider folds into every later read
      // (tangle-network/agent-runtime#2756). One second stands in for it, so the first
      // observation is aborted mid-turn the way it was in production.
      const first = await provider.create({
        profile,
        idempotencyKey: key,
        metadata: { retainedIdempotencyKey: key },
        signal: AbortSignal.timeout(1_000),
      });
      const dispatched = await first.dispatch!(turn);
      const controlRef = dispatched.controlRef as AgentExactRunControlRef;
      await expect(
        first.session!(turn.sessionId, { controlRef }).result(),
      ).rejects.toThrow(/aborted due to timeout/u);

      // The next attempt: the environment by id, bound to its retained key, the same turn again.
      const again = await provider.get!(first.id);
      expect(again?.id).toBe(first.id);
      expect(again?.creation).toBeUndefined();
      expect(again?.metadata?.retainedIdempotencyKey).toBe(key);
      const replayed = await again!.dispatch!(turn);
      expect(replayed.controlRef).toEqual(controlRef);
      const result = await again!.session!(turn.sessionId, { controlRef }).result();

      expect(result).toMatchObject({
        success: true,
        text: "native turn settled after a reattach",
        sessionId: controlRef.sessionId,
        metadata: {
          runId: controlRef.runId,
          executionId: controlRef.executionId,
          requestDigest: controlRef.requestDigest,
          status: "done",
        },
      });
      expect(bridge.nativeTurns).toEqual([controlRef.runId]);
      expect(bridge.replays).toEqual([controlRef.runId]);
    } finally {
      await bridge.close();
    }
  }, 30_000);

  it("proves no ownership for an environment it did not create or has destroyed", async () => {
    const bridge = await startRetainedBridge(0);
    try {
      const key = "runtime:retained-unowned";
      const turn = retainedTurn("unowned");
      const provider = createCliBridgeProvider({ baseUrl: bridge.url, defaultModel: MODEL });
      await provider.capabilities();
      const created = await provider.create({
        profile,
        idempotencyKey: key,
        metadata: { retainedIdempotencyKey: key },
      });

      const elsewhere = createCliBridgeProvider({ baseUrl: bridge.url, defaultModel: MODEL });
      const unowned = await elsewhere.get!(created.id);
      expect(unowned?.id).toBe(created.id);
      expect(unowned?.metadata).toBeUndefined();
      await expect(unowned!.dispatch!(turn)).rejects.toThrow(/reconstructed cli-bridge environment/u);

      await created.destroy!();
      const destroyed = await provider.get!(created.id);
      expect(destroyed?.metadata).toBeUndefined();
      await expect(destroyed!.dispatch!(turn)).rejects.toThrow(
        /reconstructed cli-bridge environment/u,
      );
      expect(bridge.nativeTurns).toEqual([]);
    } finally {
      await bridge.close();
    }
  }, 30_000);
});
