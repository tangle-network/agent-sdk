import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxInstance,
  type SandboxEvent,
  type TangleSandboxClient,
} from "@tangle-network/sandbox";
import {
  createTangleProvider,
  type SandboxClientLike,
  type SandboxInstanceLike,
  type SandboxSessionLike,
} from "@tangle-network/agent-provider-tangle";

function acceptPublicTangleClient(client: TangleSandboxClient): SandboxClientLike {
  return client;
}

void acceptPublicTangleClient;

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of values) output.push(value);
  return output;
}

describe("packed Tangle exact-session control", () => {
  it("uses the required public Sandbox SDK version", () => {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@tangle-network/sandbox");
    const manifest = JSON.parse(
      readFileSync(resolve(dirname(entry), "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    expect(manifest.version).toBe("0.19.4");
  });

  it("adapts the actual public Sandbox instance without inventing branching", async () => {
    const publicInstance = new SandboxInstance(
      {
        fetch: async () => {
          throw new Error("packed surface check must not make a network request");
        },
      } as never,
      {
        id: "sandbox-public-surface",
        status: "running",
        createdAt: new Date("2026-08-01T20:00:00.000Z"),
      },
    );
    const provider = createTangleProvider({
      client: { create: async () => publicInstance },
    });
    const capabilities = await provider.capabilities();
    const environment = await provider.create({ profile: { name: "packed" } });

    expect(typeof publicInstance.snapshot).toBe("function");
    expect(typeof publicInstance.branch).toBe("function");
    expect(capabilities.branching).toEqual({ checkpoint: false, fork: false });
    expect(environment.checkpoint).toBeUndefined();
    expect(environment.fork).toBeUndefined();
  });

  it("binds result replay and cancellation to the dispatch receipt", async () => {
    const resultSelector = vi.fn();
    const eventSelector = vi.fn();
    const interrupt = vi.fn(async () => ({ cancelled: true }));
    const session: SandboxSessionLike = {
      id: "session-1",
      status: async () => ({ status: "completed" }),
      async *events() {
        yield {
          id: "event-1",
          type: "status",
          data: {
            status: "processing",
            executionId: "execution-1",
            sessionId: "session-1",
          },
        } as SandboxEvent;
        yield {
          id: "event-2",
          type: "result",
          data: {
            finalText: "ok",
            executionId: "execution-1",
            sessionId: "session-1",
          },
        } as SandboxEvent;
      },
      result: async (options) => {
        resultSelector(options);
        return {
          success: true,
          status: "success",
          response: "ok",
          executionId: "execution-1",
          durationMs: 1,
        };
      },
      prompt: async (_message, options) => ({
        success: true,
        status: "success",
        response: "ok",
        executionId: options?.executionId,
        durationMs: 1,
      }),
      interrupt,
    };
    const box: SandboxInstanceLike = {
      id: "sandbox-1",
      async *streamPrompt(_message, options) {
        eventSelector(options);
        const events = [
          {
            id: "event-1",
            type: "status",
            data: {
              status: "processing",
              executionId: "execution-1",
              sessionId: "session-1",
            },
          },
          {
            id: "event-2",
            type: "result",
            data: {
              finalText: "ok",
              executionId: "execution-1",
              sessionId: "session-1",
            },
          },
        ] as SandboxEvent[];
        const start = options?.lastEventId === "event-1" ? 1 : 0;
        for (const event of events.slice(start)) yield event;
      },
      dispatchPrompt: async (_prompt, options) => ({
        sessionId: options?.sessionId ?? session.id,
        executionId: options?.executionId ?? "execution-1",
        runControlRef: options?.runControlRef,
        status: "running",
        alreadyExisted: false,
        dispatched: true,
      }),
      session: () => session,
    };
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "packed" } });
    const dispatched = await environment.dispatch!({
      prompt: "run",
      turnId: "turn-1",
      sessionId: session.id,
      executionId: "execution-1",
      detach: true,
    });
    expect(dispatched.controlRef).toMatchObject({
      runId: "execution-1",
      sessionId: "session-1",
      executionId: "execution-1",
    });

    const retained = environment.session!(session.id, {
      controlRef: dispatched.controlRef,
    });
    await collect(retained.events({ since: "event-1" }));
    await expect(retained.result()).resolves.toMatchObject({
      success: true,
      text: "ok",
    });
    await retained.cancel();

    expect(eventSelector).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "execution-1" }),
    );
    expect(resultSelector).toHaveBeenCalledWith({ executionId: "execution-1" });
    expect(interrupt).toHaveBeenCalledWith({ executionId: "execution-1" });
  });

  it("fails closed when Sandbox does not prove an exact execution", async () => {
    const session: SandboxSessionLike = {
      id: "session-unproven",
      status: async () => ({ status: "completed" }),
      async *events() {},
      result: async () => ({
        success: true,
        status: "success",
        durationMs: 1,
      }),
      prompt: async () => ({
        success: true,
        status: "success",
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = {
      id: "sandbox-unproven",
      async *streamPrompt() {},
      dispatchPrompt: async (_prompt, options) => ({
        sessionId: options?.sessionId ?? session.id,
        status: "running",
        alreadyExisted: false,
        dispatched: true,
      }),
      session: () => session,
    };
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "packed" } });

    await expect(
      environment.dispatch!({
        prompt: "run",
        turnId: "turn-unproven",
        sessionId: session.id,
      }),
    ).rejects.toThrow(/no exact execution id/);
    await expect(
      environment.session!(session.id).prompt({
        prompt: "run",
        turnId: "turn-unproven",
      }),
    ).rejects.toThrow(/did not confirm its exact executionId/);
  });
});
