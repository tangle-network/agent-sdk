import { randomUUID } from "node:crypto";
import {
  TerminalAttachRequestSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalSessionRefSchema,
  terminalSessionUsable,
} from "@tangle-network/agent-interface";
import type {
  AgentTerminalSession,
  TerminalAttachRequest,
  TerminalAttachResult,
  TerminalDetachAck,
  TerminalInput,
  TerminalOutputEvent,
  TerminalResize,
  TerminalSessionRef,
} from "@tangle-network/agent-interface";
import type {
  SandboxInstanceLike,
  SandboxTerminalInfoLike,
  SandboxTerminalReadyLike,
  SandboxTerminalStreamLike,
  SandboxTerminalsLike,
} from "./tangle-types.js";
import { TerminalFrameLog } from "./tangle-terminal-frames.js";
import {
  awaitWithSignal,
  awaitWithSignalAndCleanup,
  MAX_STRING_LENGTH,
} from "./tangle-contract-safety.js";
import { transportFailureReason } from "./tangle-failure-reason.js";
import { assertOptionKeys } from "./tangle-environment-validation.js";

const MAX_TERMINAL_DIMENSION = 10_000;

/** Terminal handles this environment holds, keyed by terminal session id. */
export interface TangleTerminalRegistry {
  attach(
    request: TerminalAttachRequest,
    options?: { signal?: AbortSignal },
  ): Promise<TerminalAttachResult>;
  get(terminalSessionId: string): AgentTerminalSession;
}

/** True when this sandbox backs the interactive terminal surface. */
export function sandboxBacksInteractiveTerminal(box: SandboxInstanceLike): boolean {
  // Attach opens the PTY socket; `get` supplies the shell, working directory,
  // and geometry a terminal reference must state. Neither alone is enough.
  // The member is an accessor on the SDK class, so a client that cannot build
  // the manager fails the check instead of failing the capability read.
  try {
    const terminals = box.terminals;
    return (
      typeof terminals?.attach === "function" && typeof terminals?.get === "function"
    );
  } catch {
    return false;
  }
}

/** Mutable facts one attached terminal keeps between calls. */
interface TerminalState {
  terminalSessionId: string;
  parentExecutionId: string;
  connectionId: string;
  name: string;
  shell: string;
  command?: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  runtimeLastActivityMs: number;
  localLastActivityMs: number;
  detachTimeoutMs: number;
  isRunning: boolean;
  exitCode?: number;
  exitSignal?: string;
  attachCount: number;
}

/** One attached terminal and the socket that serves it. */
interface AttachedTerminal {
  session: AgentTerminalSession;
  stream: SandboxTerminalStreamLike;
}

/** Stream state captured from handlers that are installed before attach. */
export interface TangleTerminalStreamCapture {
  readonly handlers: {
    onReady(info: SandboxTerminalReadyLike): void;
    onData(data: Uint8Array): void;
    onExit(info: { exitCode?: number; exitSignal?: string }): void;
    onError(error: Error): void;
    onClose(): void;
  };
  readonly log: TerminalFrameLog;
  readonly activity: { localMs: number };
  readonly exit: { exitCode?: number; exitSignal?: string; seen: boolean };
  readonly ready: SandboxTerminalReadyLike | undefined;
}

/** A live stream after its exact identity and runtime metadata are checked. */
export type PreparedTangleTerminal =
  | {
      status: "ready";
      session: AgentTerminalSession;
      stream: SandboxTerminalStreamLike;
      acknowledgement: SandboxTerminalReadyLike;
    }
  | {
      status: "unknown";
      message: string;
      retryable: boolean;
    };

/**
 * Install one ordered capture before a terminal socket opens.
 *
 * Both generic shells and exact coding-agent sessions use this capture. This
 * keeps replay, resize, exit, and transport ordering identical on both paths.
 */
export function createTangleTerminalStreamCapture(
  geometry?: { cols?: number; rows?: number },
): TangleTerminalStreamCapture {
  const log = new TerminalFrameLog();
  const activity = { localMs: Date.now() };
  const exit: { exitCode?: number; exitSignal?: string; seen: boolean } = {
    seen: false,
  };
  const decoder = new TextDecoder();
  let ready: SandboxTerminalReadyLike | undefined;
  return {
    log,
    activity,
    exit,
    get ready() {
      return ready;
    },
    handlers: {
      onReady(info) {
        ready = info;
        log.append({
          type: "ready",
          ...(geometry?.cols === undefined ? {} : { cols: geometry.cols }),
          ...(geometry?.rows === undefined ? {} : { rows: geometry.rows }),
        });
      },
      onData(data) {
        activity.localMs = Date.now();
        log.appendOutput(decoder.decode(data, { stream: true }));
      },
      onExit(info) {
        exit.seen = true;
        exit.exitCode = info.exitCode;
        exit.exitSignal = info.exitSignal;
        log.append({
          type: "exit",
          ...(Number.isSafeInteger(info.exitCode)
            ? { exitCode: info.exitCode as number }
            : {}),
          ...(typeof info.exitSignal === "string" && info.exitSignal.length > 0
            ? { exitSignal: info.exitSignal }
            : {}),
        });
        log.end();
      },
      onError(error) {
        log.append({ type: "error", message: socketErrorFrame(error) });
      },
      onClose() {
        log.end();
      },
    },
  };
}

/**
 * Validate one attached socket and adapt it to the shared terminal contract.
 *
 * The runtime acknowledgement and metadata are authoritative. A missing or
 * different session id closes the socket and returns no usable handle.
 */
export async function prepareTangleTerminalAttachment(input: {
  stream: SandboxTerminalStreamLike;
  capture: TangleTerminalStreamCapture;
  terminals: SandboxTerminalsLike;
  parentExecutionId: string;
  expectedSessionId?: string;
  signal?: AbortSignal;
  attachCount?: (terminalSessionId: string) => number;
  release?: (
    terminalSessionId: string,
    stream: SandboxTerminalStreamLike,
  ) => void;
}): Promise<PreparedTangleTerminal> {
  let streamClosed = false;
  const closePreparedStream = async (): Promise<void> => {
    if (streamClosed) return;
    streamClosed = true;
    await closeQuietly(input.stream);
  };

  let handedOff = false;
  try {
    input.signal?.throwIfAborted();

    let acknowledgement: SandboxTerminalReadyLike | undefined;
    try {
      acknowledgement = input.capture.ready ?? input.stream.ready;
    } catch (error) {
      await closePreparedStream();
      return {
        status: "unknown",
        message: transportFailureReason("terminal acknowledgement", error),
        retryable: true,
      };
    }
    if (
      acknowledgement === undefined ||
      typeof acknowledgement.sessionId !== "string" ||
      acknowledgement.sessionId.length === 0
    ) {
      await closePreparedStream();
      return {
        status: "unknown",
        message: "the Tangle terminal transport attached without a session id",
        retryable: false,
      };
    }
    if (
      input.expectedSessionId !== undefined &&
      acknowledgement.sessionId !== input.expectedSessionId
    ) {
      await closePreparedStream();
      return {
        status: "unknown",
        message: "the Tangle terminal transport attached a different terminal session",
        retryable: false,
      };
    }
    if (
      !Number.isSafeInteger(acknowledgement.detachTimeoutMs) ||
      acknowledgement.detachTimeoutMs <= 0
    ) {
      await closePreparedStream();
      return {
        status: "unknown",
        message: "the Tangle terminal transport reported no detach window",
        retryable: false,
      };
    }
    let info: SandboxTerminalInfoLike | null;
    try {
      info = await awaitWithSignal(
        input.terminals.get(acknowledgement.sessionId),
        input.signal,
      );
    } catch (error) {
      await closePreparedStream();
      input.signal?.throwIfAborted();
      return {
        status: "unknown",
        message: transportFailureReason("terminal metadata read", error),
        retryable: true,
      };
    }
    input.signal?.throwIfAborted();
    if (info === null || info === undefined) {
      await closePreparedStream();
      return {
        status: "unknown",
        message: "the Tangle runtime reported no metadata for the attached terminal",
        retryable: true,
      };
    }
    const state = terminalStateFromInfo(
      info,
      acknowledgement,
      input.parentExecutionId,
      input.capture.activity.localMs,
    );
    if (typeof state === "string") {
      await closePreparedStream();
      return { status: "unknown", message: state, retryable: false };
    }
    state.attachCount = input.attachCount?.(state.terminalSessionId) ?? 1;
    const session = createTangleTerminalSession(
      input.stream,
      input.capture.log,
      state,
      input.capture.activity,
      input.capture.exit,
      () => input.release?.(state.terminalSessionId, input.stream),
    );
    input.signal?.throwIfAborted();
    handedOff = true;
    return {
      status: "ready",
      session,
      stream: input.stream,
      acknowledgement,
    };
  } catch (error) {
    if (!handedOff) await closePreparedStream();
    input.signal?.throwIfAborted();
    throw error;
  }
}

export function createTangleTerminalRegistry(
  box: SandboxInstanceLike,
): TangleTerminalRegistry {
  const attached = new Map<string, AttachedTerminal>();
  return {
    async attach(
      request: TerminalAttachRequest,
      options?: { signal?: AbortSignal },
    ): Promise<TerminalAttachResult> {
      assertOptionKeys(options, ["signal"], "Tangle terminal attach");
      const exactRequest = TerminalAttachRequestSchema.parse(request);
      options?.signal?.throwIfAborted();
      const terminals = box.terminals;
      if (
        terminals === undefined ||
        typeof terminals.attach !== "function" ||
        typeof terminals.get !== "function"
      ) {
        return {
          status: "unavailable",
          reason: "the Sandbox client exposes no interactive terminal transport",
        };
      }
      if (exactRequest.mode === "logical") {
        // Sandbox resumes a terminal by reattaching its PTY and replaying the
        // retained screen. It exposes no way to read that history without
        // attaching, so a logical resume is refused rather than served by an
        // attach the caller did not ask for.
        return {
          status: "unavailable",
          reason:
            'the Tangle sandbox transport has no logical terminal resume; attach with mode "attach"',
        };
      }
      const connectionId =
        exactRequest.connectionId ?? exactRequest.terminalSessionId ?? randomUUID();
      const capture = createTangleTerminalStreamCapture({
        cols: exactRequest.cols,
        rows: exactRequest.rows,
      });
      let stream: SandboxTerminalStreamLike;
      try {
        stream = await awaitWithSignalAndCleanup(
          () => terminals.attach(connectionId, {
            ...(exactRequest.cols === undefined ? {} : { cols: exactRequest.cols }),
            ...(exactRequest.rows === undefined ? {} : { rows: exactRequest.rows }),
            ...(exactRequest.command === undefined
              ? {}
              : { command: exactRequest.command }),
            ...(exactRequest.cwd === undefined ? {} : { cwd: exactRequest.cwd }),
            handlers: capture.handlers,
          }),
          options?.signal,
          closeQuietly,
        );
      } catch (error) {
        options?.signal?.throwIfAborted();
        return {
          status: "unknown",
          message: transportFailureReason("terminal attach", error),
          retryable: true,
        };
      }
      if (options?.signal?.aborted) {
        await closeQuietly(stream);
        options.signal.throwIfAborted();
      }
      const prepared = await prepareTangleTerminalAttachment({
        stream,
        capture,
        terminals,
        parentExecutionId: exactRequest.parentExecutionId,
        expectedSessionId: exactRequest.terminalSessionId,
        signal: options?.signal,
        attachCount: (terminalSessionId) => {
          const previous = attached.get(terminalSessionId);
          return previous === undefined ? 1 : previous.session.ref.attachCount + 1;
        },
        release: (terminalSessionId, heldStream) => {
          if (attached.get(terminalSessionId)?.stream === heldStream) {
            attached.delete(terminalSessionId);
          }
        },
      });
      if (prepared.status === "unknown") return prepared;
      const previous = attached.get(prepared.session.ref.terminalSessionId);
      attached.set(prepared.session.ref.terminalSessionId, {
        session: prepared.session,
        stream: prepared.stream,
      });
      // The registry holds one socket per terminal. The socket this attach
      // replaces stays open on the runtime until its own close, so it is
      // closed here rather than abandoned with the handle that owned it.
      if (previous !== undefined) await closeQuietly(previous.stream);
      return {
        status:
          prepared.acknowledgement.restored === true ? "reattached" : "attached",
        mode: "attach",
        ref: prepared.session.ref,
        attachCount: prepared.session.ref.attachCount,
      };
    },
    get(terminalSessionId: string): AgentTerminalSession {
      const held = attached.get(terminalSessionId);
      if (held === undefined) {
        throw new Error("Tangle terminal is not attached through this environment");
      }
      return held.session;
    },
  };
}

/**
 * Build the terminal facts from what the runtime reported. Every field a
 * terminal reference must state is required here: a runtime that omits one
 * cannot be described, so the attach fails closed rather than inventing a
 * shell, a directory, or a geometry the PTY does not have.
 */
function terminalStateFromInfo(
  info: SandboxTerminalInfoLike,
  ready: SandboxTerminalReadyLike,
  parentExecutionId: string,
  localLastActivityMs: number,
): TerminalState | string {
  const name = boundedLabel(info.name);
  if (name === undefined) return "the Tangle runtime reported a terminal without a name";
  const shell = boundedLabel(info.shell);
  if (shell === undefined) return "the Tangle runtime reported a terminal without a shell";
  const cwd = boundedLabel(info.cwd);
  if (cwd === undefined) {
    return "the Tangle runtime reported a terminal without a working directory";
  }
  const cols = terminalDimension(info.cols);
  const rows = terminalDimension(info.rows);
  if (cols === undefined || rows === undefined) {
    return "the Tangle runtime reported a terminal without a valid geometry";
  }
  const createdAt = isoTimestamp(info.createdAt);
  const lastActivityMs = epochMs(info.lastActivityAt);
  if (createdAt === undefined || lastActivityMs === undefined) {
    return "the Tangle runtime reported a terminal without valid timestamps";
  }
  if (typeof info.isRunning !== "boolean") {
    return "the Tangle runtime reported a terminal without a running state";
  }
  return {
    terminalSessionId: ready.sessionId,
    parentExecutionId,
    connectionId: ready.connectionId,
    name,
    shell,
    ...(boundedLabel(info.command) === undefined
      ? {}
      : { command: boundedLabel(info.command) as string }),
    cwd,
    cols,
    rows,
    createdAt,
    runtimeLastActivityMs: lastActivityMs,
    localLastActivityMs,
    detachTimeoutMs: ready.detachTimeoutMs,
    isRunning: info.isRunning,
    ...(Number.isSafeInteger(info.exitCode) ? { exitCode: info.exitCode as number } : {}),
    ...(boundedLabel(info.exitSignal) === undefined
      ? {}
      : { exitSignal: boundedLabel(info.exitSignal) as string }),
    attachCount: 1,
  };
}

function createTangleTerminalSession(
  stream: SandboxTerminalStreamLike,
  log: TerminalFrameLog,
  state: TerminalState,
  activity: { localMs: number },
  exit: { exitCode?: number; exitSignal?: string; seen: boolean },
  release: () => void,
): AgentTerminalSession {
  // A reference describes what this handle can do with its own socket. The
  // runtime keeps a detached PTY alive, but a closed socket carries no input
  // and no output, so a detached or closed handle reports the terminal as not
  // running and every operation that needs a live socket is denied. The handle
  // releases its registry entry at that same instant, before the socket close
  // it cannot un-commit, so a close that fails mid-flight leaks no entry.
  let detached = false;
  const socketOpen = (): boolean => detached === false && stream.isOpen !== false;
  const currentRef = (): TerminalSessionRef => {
    const lastActivityMs = Math.max(state.runtimeLastActivityMs, activity.localMs);
    return TerminalSessionRefSchema.parse({
      terminalSessionId: state.terminalSessionId,
      parentExecutionId: state.parentExecutionId,
      name: state.name,
      shell: state.shell,
      ...(state.command === undefined ? {} : { command: state.command }),
      cwd: state.cwd,
      cols: state.cols,
      rows: state.rows,
      connectionId: state.connectionId,
      createdAt: state.createdAt,
      lastActivityAt: new Date(lastActivityMs).toISOString(),
      // The runtime keeps a detached PTY for its detach window and no longer,
      // so the reference expires one window after the last activity it can
      // prove. An attached socket keeps renewing that instant, and a reference
      // read after the window denies use instead of guessing.
      expiresAt: new Date(lastActivityMs + state.detachTimeoutMs).toISOString(),
      isRunning: state.isRunning && !exit.seen && socketOpen(),
      ...(exit.seen && Number.isSafeInteger(exit.exitCode)
        ? { exitCode: exit.exitCode as number }
        : state.exitCode === undefined
          ? {}
          : { exitCode: state.exitCode }),
      ...(exit.seen && typeof exit.exitSignal === "string" && exit.exitSignal.length > 0
        ? { exitSignal: exit.exitSignal }
        : state.exitSignal === undefined
          ? {}
          : { exitSignal: state.exitSignal }),
      attachCount: state.attachCount,
    });
  };
  const assertUsable = (operation: string): void => {
    if (!terminalSessionUsable(currentRef(), new Date().toISOString())) {
      throw new Error(`Tangle terminal ${operation} requires a live, unexpired terminal`);
    }
  };
  return {
    get ref(): TerminalSessionRef {
      return currentRef();
    },
    get cursors() {
      return log.cursors;
    },
    async input(input: TerminalInput, options?: { signal?: AbortSignal }): Promise<void> {
      assertOptionKeys(options, ["signal"], "Tangle terminal input");
      const exactInput = TerminalInputSchema.parse(input);
      options?.signal?.throwIfAborted();
      assertUsable("input");
      stream.write(exactInput.data);
      activity.localMs = Date.now();
    },
    async resize(resize: TerminalResize, options?: { signal?: AbortSignal }): Promise<void> {
      assertOptionKeys(options, ["signal"], "Tangle terminal resize");
      const exactResize = TerminalResizeSchema.parse(resize);
      options?.signal?.throwIfAborted();
      assertUsable("resize");
      stream.resize(exactResize.cols, exactResize.rows);
      state.cols = exactResize.cols;
      state.rows = exactResize.rows;
      activity.localMs = Date.now();
      // The runtime does not echo a geometry change, so the ordered frame log
      // records it here; a consumer replaying frames sees the resize in order
      // with the output it applies to.
      log.append({ type: "resize", cols: exactResize.cols, rows: exactResize.rows });
    },
    async detach(options?: { signal?: AbortSignal }): Promise<TerminalDetachAck> {
      assertOptionKeys(options, ["signal"], "Tangle terminal detach");
      options?.signal?.throwIfAborted();
      detached = true;
      release();
      await awaitWithSignal(stream.close(), options?.signal);
      state.attachCount = Math.max(0, state.attachCount - 1);
      return {
        status: "detached",
        terminalSessionId: state.terminalSessionId,
        connectionId: state.connectionId,
      };
    },
    async close(options?: { signal?: AbortSignal }): Promise<TerminalDetachAck> {
      assertOptionKeys(options, ["signal"], "Tangle terminal close");
      options?.signal?.throwIfAborted();
      detached = true;
      release();
      await awaitWithSignal(stream.close(), options?.signal);
      state.attachCount = Math.max(0, state.attachCount - 1);
      if (exit.seen) {
        state.isRunning = false;
        return {
          status: "closed",
          terminalSessionId: state.terminalSessionId,
          ...(Number.isSafeInteger(exit.exitCode) ? { exitCode: exit.exitCode as number } : {}),
          ...(typeof exit.exitSignal === "string" && exit.exitSignal.length > 0
            ? { exitSignal: exit.exitSignal }
            : {}),
        };
      }
      // Sandbox exposes no terminal delete, so a socket close only detaches:
      // the PTY survives until its detach window expires. Reporting `closed`
      // would claim a termination this adapter cannot prove.
      return {
        status: "unknown",
        terminalSessionId: state.terminalSessionId,
        message:
          "the Sandbox client exposes no terminal delete; the runtime keeps this PTY until its detach window expires",
        retryable: false,
      };
    },
    events(options?: {
      since?: number;
      signal?: AbortSignal;
    }): AsyncIterable<TerminalOutputEvent> {
      assertOptionKeys(options, ["since", "signal"], "Tangle terminal events");
      // The absent cursor stays absent: the frame log resolves it to the oldest
      // frame it still retains. Naming 0 here would hand a fresh consumer the
      // one cursor the log refuses once the buffer has evicted an output frame.
      return log.read(options?.since, options?.signal);
    },
  };
}

async function closeQuietly(stream: SandboxTerminalStreamLike): Promise<void> {
  try {
    await stream.close();
  } catch {
    // The attach already failed, and the socket is being abandoned. The
    // caller's failure is reported from the attach result it receives.
  }
}

function boundedLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}

function terminalDimension(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_TERMINAL_DIMENSION
    ? value
    : undefined;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  const time = epochMs(value);
  return time === undefined ? undefined : new Date(time).toISOString();
}

function socketErrorFrame(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  return trimmed.length === 0
    ? "the Tangle terminal transport failed without a message"
    : trimmed.slice(0, MAX_STRING_LENGTH);
}
