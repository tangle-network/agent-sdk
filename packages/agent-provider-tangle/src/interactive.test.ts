import {
  canonicalAgentProfileDigest,
  type AgentProfile,
  type AgentTerminalSession,
} from "@tangle-network/agent-interface";
import { describe, expect, it, vi } from "vitest";
import { createTangleInteractiveAgentRegistry } from "./tangle-interactive.js";
import { defaultTangleSandboxCapabilities } from "./tangle-capabilities.js";
import { sandboxInstanceAsEnvironment } from "./tangle-environment.js";
import type {
  SandboxInstanceLike,
  SandboxInteractiveSessionLike,
  SandboxInteractiveSessionStatusLike,
  SandboxTerminalHandlersLike,
  SandboxTerminalStreamLike,
} from "./tangle-types.js";

const startedAt = "2026-08-16T00:00:00.000Z";
const endedAt = "2026-08-16T00:05:00.000Z";
const profile: AgentProfile = {
  name: "durable-pi",
  harness: "pi",
  model: { default: "tangle/glm-5.2", reasoningEffort: "high" },
  prompt: { instructions: ["Fix the failing test."] },
};
const profileDigest = canonicalAgentProfileDigest(profile);
const run = {
  runId: "run-1",
  provider: "tangle-sandbox",
  environmentId: "sandbox-1",
  sessionId: "session-1",
  executionId: "execution-1",
  requestDigest: `sha256:${"a".repeat(64)}` as const,
};

function fixture(options?: {
  startIdentity?: Partial<{
    sessionId: string;
    harness: "pi" | "codex";
    profileDigest: string;
    startedAt: string;
  }>;
  restored?: boolean;
}) {
  let lifecycle: SandboxInteractiveSessionStatusLike | null = {
    state: "running",
    sessionId: run.sessionId,
    harness: "pi",
    profileDigest,
    startedAt,
    streamUrl: `/terminals/${run.sessionId}/ws`,
  };
  const writes: Array<string | Uint8Array> = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const streams: SandboxTerminalStreamLike[] = [];
  const start = vi.fn(async () => ({
    sessionId: options?.startIdentity?.sessionId ?? run.sessionId,
    harness: options?.startIdentity?.harness ?? "pi",
    profileDigest: options?.startIdentity?.profileDigest ?? profileDigest,
    startedAt: options?.startIdentity?.startedAt ?? startedAt,
    streamUrl: `/terminals/${run.sessionId}/ws`,
  }));
  const status = vi.fn(async () => lifecycle);
  const sendPrompt = vi.fn(async () => {});
  const stop = vi.fn(async () => {
    lifecycle = {
      state: "exited",
      sessionId: run.sessionId,
      harness: "pi",
      profileDigest,
      startedAt,
      endedAt,
      reason: "stopped",
      exitCode: 0,
    };
  });
  const attach = vi.fn(
    async (attachOptions?: {
      cols?: number;
      rows?: number;
      handlers?: SandboxTerminalHandlersLike;
    }): Promise<SandboxTerminalStreamLike> => {
      const ready = {
        connectionId: run.sessionId,
        sessionId: run.sessionId,
        restored: options?.restored ?? true,
        detachTimeoutMs: 300_000,
      };
      let open = true;
      const stream: SandboxTerminalStreamLike = {
        connectionId: run.sessionId,
        ready,
        get isOpen() {
          return open;
        },
        write(data) {
          writes.push(data);
        },
        resize(cols, rows) {
          resizes.push({ cols, rows });
        },
        async close() {
          open = false;
          attachOptions?.handlers?.onClose?.(1000, "detached");
        },
      };
      attachOptions?.handlers?.onReady?.(ready);
      attachOptions?.handlers?.onData?.(
        new TextEncoder().encode("Pi is ready.\r\n"),
      );
      streams.push(stream);
      return stream;
    },
  );
  const interactive: SandboxInteractiveSessionLike = {
    start,
    status,
    attach,
    sendPrompt,
    stop,
  };
  const box: SandboxInstanceLike = {
    id: run.environmentId,
    async *streamPrompt() {},
    session: (id) => ({
      id,
      interactive: () => interactive,
      status: async () => null,
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
      interrupt: async () => ({ cancelled: false }),
    }),
    terminals: {
      get: vi.fn(async (sessionId) => ({
        sessionId,
        connectionId: sessionId,
        name: "Interactive pi",
        shell: "/bin/bash",
        command: "pi",
        cwd: "/workspace",
        cols: 120,
        rows: 40,
        createdAt: startedAt,
        lastActivityAt: startedAt,
        isRunning: true,
      })),
      attach: vi.fn(async () => {
        throw new Error("generic terminal attach must not be called");
      }),
    },
  };
  return {
    box,
    start,
    status,
    attach,
    sendPrompt,
    stop,
    streams,
    writes,
    resizes,
    setLifecycle(value: SandboxInteractiveSessionStatusLike | null) {
      lifecycle = value;
    },
  };
}

function startRequest() {
  return {
    run,
    profile,
    profileDigest,
    initialPrompt: "Find and fix the failing test.",
    cwd: "/workspace",
    cols: 120,
    rows: 40,
  };
}

async function nextEvent(session: AgentTerminalSession) {
  const iterator = session.events()[Symbol.asyncIterator]();
  return await iterator.next();
}

describe("Tangle exact interactive agent sessions", () => {
  it("exposes exact TUI controls only when the deployment proves every operation", async () => {
    const test = fixture();
    test.box.status = "running";
    test.box.capabilities = async () => ({
      interactiveAgent: {
        start: true,
        status: true,
        attach: true,
        sendPrompt: true,
        stop: true,
        profileDigest: true,
      },
    });
    const client = { create: async () => test.box };
    const environment = await sandboxInstanceAsEnvironment(
      test.box,
      run.provider,
      client,
      defaultTangleSandboxCapabilities("pi"),
    );

    expect(environment.capabilities?.interactiveAgent).toEqual({
      start: true,
      status: true,
      attach: true,
      reattach: true,
      sendPrompt: true,
      input: true,
      resize: true,
      stop: true,
    });
    expect(environment.startInteractive).toBeTypeOf("function");
    expect(environment.interactive).toBeTypeOf("function");

    test.box.capabilities = async () => ({
      interactiveAgent: {
        start: true,
        status: true,
        attach: true,
        sendPrompt: true,
        stop: true,
      },
    });
    const unproved = await sandboxInstanceAsEnvironment(
      test.box,
      run.provider,
      client,
      defaultTangleSandboxCapabilities("pi"),
    );
    expect(unproved.capabilities?.interactiveAgent).toEqual({
      start: false,
      status: false,
      attach: false,
      reattach: false,
      sendPrompt: false,
      input: false,
      resize: false,
      stop: false,
    });
    expect(unproved.startInteractive).toBeUndefined();
    expect(unproved.interactive).toBeUndefined();
  });

  it("starts, attaches, drives, reattaches, and stops the exact native TUI", async () => {
    const test = fixture();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      run.provider,
      run.environmentId,
    );

    const ref = await registry.start(startRequest());
    expect(ref).toEqual({ run, profileDigest, harness: "pi", startedAt });
    expect(test.start).toHaveBeenCalledWith({
      harness: "pi",
      model: "tangle/glm-5.2",
      cwd: "/workspace",
      cols: 120,
      rows: 40,
      profile,
      initialPrompt: "Find and fix the failing test.",
    });

    const exact = registry.get(ref);
    await expect(exact.status()).resolves.toEqual({ state: "running", ref });
    const first = await exact.attach({ cols: 120, rows: 40 });
    await expect(nextEvent(first)).resolves.toMatchObject({
      value: { type: "ready", cols: 120, rows: 40 },
    });
    await first.input({ data: "y" });
    await first.resize({ cols: 100, rows: 32 });
    await first.detach();
    expect(test.writes).toEqual(["y"]);
    expect(test.resizes).toEqual([{ cols: 100, rows: 32 }]);

    const second = await exact.attach({ cols: 100, rows: 32 });
    expect(second.ref.terminalSessionId).toBe(run.sessionId);
    expect(test.attach).toHaveBeenCalledTimes(2);
    await second.detach();

    await exact.sendPrompt?.("Continue with the next test.");
    expect(test.sendPrompt).toHaveBeenCalledWith("Continue with the next test.");
    await expect(exact.stop()).resolves.toMatchObject({
      state: "exited",
      reason: "stopped",
      exitCode: 0,
      ref,
    });
  });

  it("reaps a start whose session, harness, profile, or timestamp is not exact", async () => {
    for (const startIdentity of [
      { sessionId: "another-session" },
      { harness: "codex" as const },
      { profileDigest: `sha256:${"b".repeat(64)}` },
      { startedAt: "not-a-date" },
    ]) {
      const test = fixture({ startIdentity });
      const registry = createTangleInteractiveAgentRegistry(
        test.box,
        run.provider,
        run.environmentId,
      );
      await expect(registry.start(startRequest())).rejects.toThrow(
        /different|malformed/,
      );
      expect(test.stop).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a socket that did not restore the existing agent PTY", async () => {
    const test = fixture({ restored: false });
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      run.provider,
      run.environmentId,
    );
    const ref = await registry.start(startRequest());

    await expect(registry.get(ref).attach()).rejects.toThrow(
      /created a new terminal/,
    );
    expect(test.stop).toHaveBeenCalledTimes(1);
    expect(test.streams[0]?.isOpen).toBe(false);
  });

  it("reports a lost session and rejects altered status identity", async () => {
    const test = fixture();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      run.provider,
      run.environmentId,
    );
    const ref = await registry.start(startRequest());
    const exact = registry.get(ref);
    test.setLifecycle({
      state: "exited",
      sessionId: run.sessionId,
      harness: "pi",
      profileDigest,
      startedAt,
      endedAt,
      reason: "lost",
    });
    await expect(exact.status()).resolves.toMatchObject({
      state: "exited",
      reason: "lost",
      ref,
    });

    test.setLifecycle({
      state: "running",
      sessionId: run.sessionId,
      harness: "codex",
      profileDigest,
      startedAt,
      streamUrl: "/terminals/session-1/ws",
    });
    await expect(exact.status()).rejects.toThrow(/different interactive agent/);
  });

  it("returns an explicit terminal unknown when the durable tombstone is gone", async () => {
    const test = fixture();
    const registry = createTangleInteractiveAgentRegistry(
      test.box,
      run.provider,
      run.environmentId,
    );
    const ref = await registry.start(startRequest());
    test.setLifecycle(null);

    await expect(registry.get(ref).status()).resolves.toEqual({
      state: "unknown",
      ref,
      message: "the Sandbox no longer knows this interactive agent session",
      retryable: false,
    });
  });
});
