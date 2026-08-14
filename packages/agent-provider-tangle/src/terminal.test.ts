import { describe, expect, it } from "vitest";
import type { SandboxTerminalInfo, SandboxTerminals } from "@tangle-network/sandbox";
import {
  TerminalSessionRefSchema,
  terminalAttachResultMatchesRequest,
  terminalSessionUsable,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironment,
  TerminalOutputEvent,
} from "@tangle-network/agent-interface";
import {
  createTangleProvider,
  type SandboxInstanceLike,
  type SandboxTerminalInfoLike,
  type SandboxTerminalsLike,
} from "./index.js";

/**
 * The published SDK terminal shapes are the wire facts this adapter reads.
 * Assigning them to the adapter's own shapes holds the two together: a field
 * or method the SDK renames fails here instead of failing at attach time.
 */
function acceptPublishedTerminals(terminals: SandboxTerminals): SandboxTerminalsLike {
  return terminals;
}
void acceptPublishedTerminals;
const PUBLISHED_TERMINAL: SandboxTerminalInfo = {
  sessionId: "terminal-1",
  connectionId: "connection-1",
  name: "shell-1",
  shell: "/bin/bash",
  cwd: "/workspace",
  cols: 80,
  rows: 24,
  createdAt: "2026-08-13T12:00:00.000Z",
  lastActivityAt: "2026-08-13T12:00:05.000Z",
  isRunning: true,
};
const PUBLISHED_TERMINAL_AS_READ: SandboxTerminalInfoLike = PUBLISHED_TERMINAL;

const DETACH_TIMEOUT_MS = 300_000;

interface FakeTerminalTransport {
  terminals: SandboxTerminalsLike;
  written: string[];
  resizes: Array<{ cols: number; rows: number }>;
  attachCalls: Array<{ connectionId: string; cols?: number; rows?: number }>;
  /** One record per socket the transport opened, newest last. */
  sockets: Array<{ connectionId: string; closed: boolean }>;
  emitOutput(text: string): void;
  emitExit(exit: { exitCode?: number; exitSignal?: string }): void;
  emitError(message: string): void;
  /** Drop the newest socket the way a runtime drops one, with no close call. */
  dropSocket(): void;
  closed(): boolean;
}

function fakeTerminalTransport(options?: {
  info?: SandboxTerminalInfoLike | null;
  restored?: boolean;
  sessionId?: string;
  detachTimeoutMs?: number;
  attachError?: Error;
}): FakeTerminalTransport {
  const written: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const attachCalls: Array<{ connectionId: string; cols?: number; rows?: number }> = [];
  const sockets: Array<{ connectionId: string; closed: boolean }> = [];
  const encoder = new TextEncoder();
  let handlers: Parameters<SandboxTerminalsLike["attach"]>[1] extends
    | { handlers?: infer H }
    | undefined
    ? H | undefined
    : never;
  let isClosed = false;
  const sessionId = options?.sessionId ?? PUBLISHED_TERMINAL_AS_READ.sessionId;
  const transport: FakeTerminalTransport = {
    written,
    resizes,
    attachCalls,
    sockets,
    emitOutput: (text) => handlers?.onData?.(encoder.encode(text)),
    emitExit: (exit) => handlers?.onExit?.(exit),
    emitError: (message) => handlers?.onError?.(new Error(message)),
    dropSocket: () => {
      const socket = sockets.at(-1);
      if (socket !== undefined) socket.closed = true;
    },
    closed: () => isClosed,
    terminals: {
      get: async (requested) =>
        requested === sessionId
          ? options?.info === undefined
            ? PUBLISHED_TERMINAL_AS_READ
            : options.info
          : null,
      attach: async (connectionId, attachOptions) => {
        if (options?.attachError) throw options.attachError;
        attachCalls.push({
          connectionId,
          ...(attachOptions?.cols === undefined ? {} : { cols: attachOptions.cols }),
          ...(attachOptions?.rows === undefined ? {} : { rows: attachOptions.rows }),
        });
        handlers = attachOptions?.handlers;
        // Each socket keeps its own handlers and its own open state, so closing
        // one never speaks for another.
        const ownHandlers = attachOptions?.handlers;
        const socket = { connectionId, closed: false };
        sockets.push(socket);
        const ready = {
          connectionId,
          sessionId,
          restored: options?.restored ?? false,
          detachTimeoutMs: options?.detachTimeoutMs ?? DETACH_TIMEOUT_MS,
        };
        // The runtime acknowledges the attach and then replays the retained
        // screen before `attach()` resolves, which is why the handlers are
        // registered up front.
        handlers?.onReady?.(ready);
        handlers?.onData?.(encoder.encode("replayed screen\r\n"));
        return {
          connectionId,
          ready,
          get isOpen() {
            return !socket.closed;
          },
          write: (data) => {
            written.push(
              typeof data === "string" ? data : new TextDecoder().decode(data),
            );
          },
          resize: (cols, rows) => {
            resizes.push({ cols, rows });
          },
          close: async () => {
            socket.closed = true;
            isClosed = true;
            ownHandlers?.onClose?.(1_000, "closed");
          },
        };
      },
    },
  };
  return transport;
}

async function terminalEnvironment(
  terminals: SandboxTerminalsLike | undefined,
): Promise<AgentEnvironment> {
  const box: SandboxInstanceLike = {
    id: "sbx-terminal",
    status: "running",
    async *streamPrompt() {},
    ...(terminals === undefined ? {} : { terminals }),
  };
  return await createTangleProvider({ client: { create: async () => box } }).create({
    profile: { name: "terminal" },
  });
}

async function take(
  events: AsyncIterable<TerminalOutputEvent>,
  count: number,
): Promise<TerminalOutputEvent[]> {
  const collected: TerminalOutputEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (collected.length >= count) break;
  }
  return collected;
}

async function drain(
  events: AsyncIterable<TerminalOutputEvent>,
): Promise<TerminalOutputEvent[]> {
  const collected: TerminalOutputEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Tangle interactive terminal", () => {
  it("round-trips attach, output, input, and resize over the sandbox transport", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const request = {
      parentExecutionId: "execution-1",
      mode: "attach" as const,
      cols: 120,
      rows: 40,
    };
    const attached = await environment.attachTerminal!(request);

    expect(attached.status).toBe("attached");
    expect(terminalAttachResultMatchesRequest(request, attached)).toBe(true);
    if (attached.status !== "attached") throw new Error("attach did not succeed");
    expect(TerminalSessionRefSchema.safeParse(attached.ref).success).toBe(true);
    expect(attached.ref).toMatchObject({
      terminalSessionId: "terminal-1",
      parentExecutionId: "execution-1",
      name: "shell-1",
      shell: "/bin/bash",
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      isRunning: true,
      attachCount: 1,
    });
    // The expiry is one detach window past the newest activity the adapter can
    // prove, so a reference read after the window denies use.
    expect(Date.parse(attached.ref.expiresAt)).toBeGreaterThan(Date.now());
    expect(transport.attachCalls).toEqual([
      { connectionId: expect.any(String), cols: 120, rows: 40 },
    ]);

    const session = environment.terminal!(attached.ref.terminalSessionId);
    const replayed = await take(session.events(), 2);
    expect(replayed[0]).toEqual({ type: "ready", cols: 120, rows: 40 });
    expect(replayed[1]).toEqual({ type: "output", seq: 1, data: "replayed screen\r\n" });

    await session.input({ data: "ls -la\n" });
    await session.resize({ cols: 100, rows: 30 });
    transport.emitOutput("total 0\r\n");
    transport.emitExit({ exitCode: 0 });

    expect(transport.written).toEqual(["ls -la\n"]);
    expect(transport.resizes).toEqual([{ cols: 100, rows: 30 }]);

    // The cursor is exclusive: a consumer that processed seq 1 resumes at the
    // next frame with no loss and no duplicate.
    const tail = await drain(session.events({ since: 1 }));
    expect(tail).toEqual([
      { type: "resize", cols: 100, rows: 30 },
      { type: "output", seq: 2, data: "total 0\r\n" },
      { type: "exit", exitCode: 0 },
    ]);
    expect(session.ref.isRunning).toBe(false);
  });

  it("reports a reattach and counts the attaches this environment holds", async () => {
    const transport = fakeTerminalTransport({ restored: true });
    const environment = await terminalEnvironment(transport.terminals);
    const request = {
      parentExecutionId: "execution-1",
      terminalSessionId: "terminal-1",
      connectionId: "connection-1",
      mode: "attach" as const,
    };

    const first = await environment.attachTerminal!(request);
    expect(first.status).toBe("reattached");
    if (first.status !== "reattached") throw new Error("reattach did not succeed");
    expect(first.attachCount).toBe(1);
    expect(terminalAttachResultMatchesRequest(request, first)).toBe(true);

    const second = await environment.attachTerminal!(request);
    if (second.status !== "reattached") throw new Error("reattach did not succeed");
    expect(second.attachCount).toBe(2);
    expect(transport.attachCalls.map((call) => call.connectionId)).toEqual([
      "connection-1",
      "connection-1",
    ]);
  });

  it("acknowledges a detach and refuses to claim a close it cannot prove", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const attached = await environment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    if (attached.status !== "attached") throw new Error("attach did not succeed");
    const session = environment.terminal!(attached.ref.terminalSessionId);

    await expect(session.detach()).resolves.toMatchObject({
      status: "detached",
      terminalSessionId: "terminal-1",
    });
    expect(transport.closed()).toBe(true);

    // Sandbox exposes no terminal delete, so a socket close only detaches and
    // the adapter never reports a termination it cannot prove.
    const unproven = await session.close();
    expect(unproven).toMatchObject({ status: "unknown", retryable: false });

    const exiting = fakeTerminalTransport({ sessionId: "terminal-2" });
    const exitingEnvironment = await terminalEnvironment(exiting.terminals);
    const secondAttach = await exitingEnvironment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    if (secondAttach.status !== "attached") throw new Error("attach did not succeed");
    exiting.emitExit({ exitCode: 3, exitSignal: "SIGTERM" });
    await expect(
      exitingEnvironment.terminal!("terminal-2").close(),
    ).resolves.toEqual({
      status: "closed",
      terminalSessionId: "terminal-2",
      exitCode: 3,
      exitSignal: "SIGTERM",
    });
  });

  it("fails closed when the transport cannot describe the terminal it attached", async () => {
    const missingShell = fakeTerminalTransport({
      info: { ...PUBLISHED_TERMINAL_AS_READ, shell: undefined },
    });
    const environment = await terminalEnvironment(missingShell.terminals);
    await expect(
      environment.attachTerminal!({ parentExecutionId: "execution-1", mode: "attach" }),
    ).resolves.toEqual({
      status: "unknown",
      message: "the Tangle runtime reported a terminal without a shell",
      retryable: false,
    });
    expect(missingShell.closed()).toBe(true);

    const noWindow = fakeTerminalTransport({ detachTimeoutMs: 0 });
    const windowless = await terminalEnvironment(noWindow.terminals);
    await expect(
      windowless.attachTerminal!({ parentExecutionId: "execution-1", mode: "attach" }),
    ).resolves.toEqual({
      status: "unknown",
      message: "the Tangle terminal transport reported no detach window",
      retryable: false,
    });

    const wrongSession = fakeTerminalTransport({ sessionId: "terminal-other" });
    const mismatched = await terminalEnvironment(wrongSession.terminals);
    await expect(
      mismatched.attachTerminal!({
        parentExecutionId: "execution-1",
        terminalSessionId: "terminal-1",
        mode: "attach",
      }),
    ).resolves.toEqual({
      status: "unknown",
      message: "the Tangle terminal transport attached a different terminal session",
      retryable: false,
    });

    // The transport states the request URL in its message, and that URL can
    // carry userinfo, so the attach result names the read and the structured
    // cause instead of repeating the message.
    const failing = fakeTerminalTransport({
      attachError: Object.assign(
        new Error("wss://agent:hunter2@runtime.example/terminal failed (502): refused"),
        { status: 502 },
      ),
    });
    const unreachable = await terminalEnvironment(failing.terminals);
    const refused = await unreachable.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    expect(refused).toEqual({
      status: "unknown",
      message: "the Sandbox terminal attach failed (HTTP 502)",
      retryable: true,
    });
    expect(JSON.stringify(refused)).not.toContain("hunter2");
  });

  it("refuses a logical resume the transport cannot serve", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const result = await environment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "logical",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason:
        'the Tangle sandbox transport has no logical terminal resume; attach with mode "attach"',
    });
    expect(transport.attachCalls).toEqual([]);
  });

  it("denies input and resize on a terminal that is no longer usable", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const attached = await environment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    if (attached.status !== "attached") throw new Error("attach did not succeed");
    const session = environment.terminal!(attached.ref.terminalSessionId);
    transport.emitExit({ exitCode: 0 });

    expect(terminalSessionUsable(session.ref, new Date().toISOString())).toBe(false);
    await expect(session.input({ data: "ls\n" })).rejects.toThrow(
      /requires a live, unexpired terminal/,
    );
    await expect(session.resize({ cols: 90, rows: 20 })).rejects.toThrow(
      /requires a live, unexpired terminal/,
    );
    expect(transport.written).toEqual([]);
    expect(
      terminalSessionUsable(
        { ...session.ref, isRunning: true },
        new Date(Date.now() + DETACH_TIMEOUT_MS * 2).toISOString(),
      ),
    ).toBe(false);
  });

  it("denies use of a terminal this handle detached", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const attached = await environment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    if (attached.status !== "attached") throw new Error("attach did not succeed");
    const session = environment.terminal!(attached.ref.terminalSessionId);
    expect(terminalSessionUsable(session.ref, new Date().toISOString())).toBe(true);

    await session.detach();

    // The runtime keeps the PTY, but this handle no longer holds a socket, so
    // the reference it hands out cannot read as usable.
    expect(session.ref.isRunning).toBe(false);
    expect(terminalSessionUsable(session.ref, new Date().toISOString())).toBe(false);
    await expect(session.input({ data: "ls\n" })).rejects.toThrow(
      /requires a live, unexpired terminal/,
    );
    await expect(session.resize({ cols: 90, rows: 20 })).rejects.toThrow(
      /requires a live, unexpired terminal/,
    );
    expect(transport.written).toEqual([]);
  });

  it("denies use when the runtime drops the socket under the handle", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const attached = await environment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    if (attached.status !== "attached") throw new Error("attach did not succeed");
    const session = environment.terminal!(attached.ref.terminalSessionId);

    // No detach, no exit: the socket simply goes away, which the transport
    // reports through `isOpen`.
    transport.dropSocket();

    expect(session.ref.isRunning).toBe(false);
    expect(terminalSessionUsable(session.ref, new Date().toISOString())).toBe(false);
    await expect(session.input({ data: "ls\n" })).rejects.toThrow(
      /requires a live, unexpired terminal/,
    );
  });

  it("closes the socket a reattach replaces", async () => {
    const transport = fakeTerminalTransport({ restored: true });
    const environment = await terminalEnvironment(transport.terminals);
    const request = {
      parentExecutionId: "execution-1",
      terminalSessionId: "terminal-1",
      connectionId: "connection-1",
      mode: "attach" as const,
    };

    await environment.attachTerminal!(request);
    expect(transport.sockets.map((socket) => socket.closed)).toEqual([false]);

    await environment.attachTerminal!(request);

    // The registry holds one socket per terminal, so the replaced socket is
    // closed instead of being left open on the runtime.
    expect(transport.sockets.map((socket) => socket.closed)).toEqual([true, false]);
  });

  it("states the cursors a consumer can resume from after eviction", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const attached = await environment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    if (attached.status !== "attached") throw new Error("attach did not succeed");
    const session = environment.terminal!(attached.ref.terminalSessionId);

    expect(session.cursors).toEqual({ earliest: 0, latest: 1 });
    for (let frame = 0; frame < 1_100; frame += 1) transport.emitOutput(`line ${frame}\r\n`);
    transport.emitExit({ exitCode: 0 });

    const { earliest, latest } = session.cursors;
    expect(latest).toBe(1_101);
    expect(earliest).toBeGreaterThan(0);

    // A consumer that holds nothing is told where the retained frames start
    // instead of being refused for good.
    await expect(drain(session.events({ since: 0 }))).rejects.toThrow(
      new RegExp(`older than the retained frame buffer; resume from cursor ${earliest}`),
    );

    const resumed = await drain(session.events({ since: earliest }));
    const outputs = resumed.filter(
      (frame): frame is Extract<TerminalOutputEvent, { type: "output" }> =>
        frame.type === "output",
    );
    // Resuming at the stated cursor loses no output: the first frame is the one
    // after it and the sequence runs unbroken to the newest.
    expect(outputs.at(0)?.seq).toBe(earliest + 1);
    expect(outputs.at(-1)?.seq).toBe(latest);
    expect(outputs.map((frame) => frame.seq)).toEqual(
      outputs.map((_frame, index) => earliest + 1 + index),
    );
    expect(resumed.at(-1)).toEqual({ type: "exit", exitCode: 0 });
  });

  it("refuses a replay cursor the frame buffer cannot serve", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const attached = await environment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    if (attached.status !== "attached") throw new Error("attach did not succeed");
    const session = environment.terminal!(attached.ref.terminalSessionId);

    await expect(drain(session.events({ since: 99 }))).rejects.toThrow(
      /ahead of the retained frames/,
    );
    await expect(drain(session.events({ since: -1 }))).rejects.toThrow(
      /non-negative safe integer/,
    );
  });

  it("carries a protocol error frame in order and never as terminal output", async () => {
    const transport = fakeTerminalTransport();
    const environment = await terminalEnvironment(transport.terminals);
    const attached = await environment.attachTerminal!({
      parentExecutionId: "execution-1",
      mode: "attach",
    });
    if (attached.status !== "attached") throw new Error("attach did not succeed");
    const session = environment.terminal!(attached.ref.terminalSessionId);
    transport.emitError("INIT_FAILED");
    transport.emitExit({ exitSignal: "SIGKILL" });

    const frames = await drain(session.events({ since: 1 }));
    expect(frames).toEqual([
      { type: "error", message: "INIT_FAILED" },
      { type: "exit", exitSignal: "SIGKILL" },
    ]);
  });

  it("claims no terminal capability and exposes no terminal method without the transport", async () => {
    const environment = await terminalEnvironment(undefined);

    expect(environment.capabilities?.interactiveTerminal).toEqual({
      attach: false,
      input: false,
      resize: false,
      reattach: false,
    });
    expect(environment.attachTerminal).toBeUndefined();
    expect(environment.terminal).toBeUndefined();
  });

  it("claims every terminal operation when the transport backs the socket", async () => {
    const environment = await terminalEnvironment(fakeTerminalTransport().terminals);

    expect(environment.capabilities?.interactiveTerminal).toEqual({
      attach: true,
      input: true,
      resize: true,
      reattach: true,
    });
    expect(() => environment.terminal!("terminal-unknown")).toThrow(
      /not attached through this environment/,
    );
  });
});
