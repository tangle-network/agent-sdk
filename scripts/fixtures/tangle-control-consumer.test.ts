import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxInstance,
  type SandboxEvent,
  type SandboxRuntimeCapabilities,
  type TangleSandboxClient,
} from "@tangle-network/sandbox";
import {
  createTangleProvider,
  type SandboxClientLike,
  type SandboxInstanceLike,
  type SandboxRuntimeCapabilityDocument,
  type SandboxSessionLike,
} from "@tangle-network/agent-provider-tangle";

function acceptPublicTangleClient(client: TangleSandboxClient): SandboxClientLike {
  return client;
}

void acceptPublicTangleClient;

/**
 * The wire body of `GET /capabilities` for a deployment that reports the
 * complete retained-control flag set. It carries the SDK's type because the
 * SDK parses it: a v1 document that omits a declared group is malformed, so
 * this body must stay complete even where the adapter reads only part of it.
 */
const DEPLOYMENT_CAPABILITIES: SandboxRuntimeCapabilities = {
  schema: 1,
  agentInterface: "0.49.0",
  sidecarVersion: "1.0.0-packed",
  image: `example/sidecar@sha256:${"c".repeat(64)}`,
  dispatch: { runControlRef: true, executionIdOnAdmission: true },
  cancel: { canonicalRunCancellation: true, digestBound: true, idempotent: true },
  runs: { executionScopedStatus: true, eventReplay: true },
  interactions: {},
};
const DEPLOYMENT_CAPABILITIES_AS_READ: SandboxRuntimeCapabilityDocument =
  DEPLOYMENT_CAPABILITIES;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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
    expect(manifest.version).toBe("0.23.0");
  });

  it("adapts the actual public Sandbox instance without inventing branching", async () => {
    // Composing an environment reads deployment truth, so the transport
    // answers the sandbox lookup and capability discovery and nothing else.
    const sandboxInfo = {
      id: "sandbox-public-surface",
      status: "running" as const,
      filesystemIncarnationId: "incarnation-1",
      filesystemIncarnationProvenance: "fresh" as const,
      filesystemIncarnationReadiness: "ready" as const,
      createdAt: "2026-08-01T20:00:00.000Z",
    };
    const publicInstance = new SandboxInstance(
      {
        fetch: async (path: string) => {
          if (path === `/v1/sandboxes/${sandboxInfo.id}`) {
            return jsonResponse(sandboxInfo);
          }
          if (path === `/v1/sandboxes/${sandboxInfo.id}/runtime/capabilities`) {
            return jsonResponse(DEPLOYMENT_CAPABILITIES);
          }
          throw new Error("packed surface check must not make a network request");
        },
      } as never,
      { ...sandboxInfo, createdAt: new Date(sandboxInfo.createdAt) },
    );
    const provider = createTangleProvider({
      client: { create: async () => publicInstance },
    });
    const capabilities = await provider.capabilities();
    const environment = await provider.create({ profile: { name: "packed" } });

    expect(typeof publicInstance.snapshot).toBe("function");
    expect(typeof publicInstance.branch).toBe("function");
    expect(typeof publicInstance.session("surface-probe").cancelRun).toBe(
      "function",
    );
    expect(capabilities.branching).toEqual({ checkpoint: false, fork: false });
    expect(environment.checkpoint).toBeUndefined();
    expect(environment.fork).toBeUndefined();

    // The environment-scoped document reaches a packed consumer, and the
    // operations it exposes match it. This deployment backs exact dispatch
    // and event replay, while the client offers no `get`, so the run cannot
    // be reconstructed and retained control stays unclaimed.
    expect(environment.capabilities).toMatchObject({
      streaming: { detach: true, replay: true, turnIdempotency: true },
      sessions: { continue: false },
    });
    expect(environment.capabilities).not.toHaveProperty("retainedControl");
    expect(typeof environment.dispatch).toBe("function");
    expect(typeof environment.session).toBe("function");
  });

  it("claims retained control for an SDK-backed client with reconstruction", async () => {
    const sdkBackedClient = {
      fetch: async (): Promise<Response> => {
        throw new Error("capability probe must not make a network request");
      },
      create: async (): Promise<SandboxInstanceLike> => {
        throw new Error("capabilities never create a sandbox");
      },
      get: async () => null,
    };
    const claiming = createTangleProvider({ client: sdkBackedClient });
    await expect(claiming.capabilities()).resolves.toMatchObject({
      sessions: { continue: true },
      retainedControl: {
        exactRunIdentity: true,
        resultIdentity: true,
        eventIdentity: true,
        cancellationIdempotency: true,
      },
    });

    // A client without the SDK probe surface cannot prove cancelRun.
    const unproven = createTangleProvider({
      client: {
        create: async (): Promise<SandboxInstanceLike> => {
          throw new Error("capabilities never create a sandbox");
        },
        get: async () => null,
      },
    });
    const narrowed = await unproven.capabilities();
    expect(narrowed.sessions.continue).toBe(false);
    expect(narrowed).not.toHaveProperty("retainedControl");
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
      status: "running",
      capabilities: async () => DEPLOYMENT_CAPABILITIES_AS_READ,
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
      status: "running",
      capabilities: async () => DEPLOYMENT_CAPABILITIES_AS_READ,
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
