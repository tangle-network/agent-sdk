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
} from "./tangle-types.js";
import { TerminalFrameLog } from "./tangle-terminal-frames.js";
import { awaitWithSignal, MAX_STRING_LENGTH } from "./tangle-contract-safety.js";
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
      const log = new TerminalFrameLog();
      const activity = { localMs: Date.now() };
      const exit: { exitCode?: number; exitSignal?: string; seen: boolean } = {
        seen: false,
      };
      const decoder = new TextDecoder();
      let ready: SandboxTerminalReadyLike | undefined;
      let stream: SandboxTerminalStreamLike;
      try {
        stream = await awaitWithSignal(
          terminals.attach(connectionId, {
            ...(exactRequest.cols === undefined ? {} : { cols: exactRequest.cols }),
            ...(exactRequest.rows === undefined ? {} : { rows: exactRequest.rows }),
            ...(exactRequest.command === undefined
              ? {}
              : { command: exactRequest.command }),
            ...(exactRequest.cwd === undefined ? {} : { cwd: exactRequest.cwd }),
            handlers: {
              onReady: (info) => {
                ready = info;
                log.append({
                  type: "ready",
                  ...(exactRequest.cols === undefined ? {} : { cols: exactRequest.cols }),
                  ...(exactRequest.rows === undefined ? {} : { rows: exactRequest.rows }),
                });
              },
              onData: (data) => {
                activity.localMs = Date.now();
                log.appendOutput(decoder.decode(data, { stream: true }));
              },
              onExit: (info) => {
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
              onError: (error) => {
                // A frame belongs to the PTY stream, which carries whatever the
                // terminal itself produced, so the socket error is carried as
                // the terminal reports it and only its length is bounded.
                log.append({ type: "error", message: socketErrorFrame(error) });
              },
              onClose: () => {
                log.end();
              },
            },
          }),
          options?.signal,
        );
      } catch (error) {
        options?.signal?.throwIfAborted();
        return {
          status: "unknown",
          message: transportFailureReason("terminal attach", error),
          retryable: true,
        };
      }
      options?.signal?.throwIfAborted();
      let acknowledgement: SandboxTerminalReadyLike | undefined;
      try {
        // `ready` is an accessor on the SDK stream that throws until the
        // runtime's acknowledgement arrives. Read outside a guard it would
        // replace this attach's result with a raw transport error and abandon
        // the socket the attach opened.
        acknowledgement = ready ?? stream.ready;
      } catch (error) {
        await closeQuietly(stream);
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
        await closeQuietly(stream);
        return {
          status: "unknown",
          message: "the Tangle terminal transport attached without a session id",
          retryable: false,
        };
      }
      if (
        exactRequest.terminalSessionId !== undefined &&
        acknowledgement.sessionId !== exactRequest.terminalSessionId
      ) {
        await closeQuietly(stream);
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
        // The detach window is the only bound on how long the runtime keeps
        // this PTY, so without it the reference cannot state an expiry and
        // every later call would be unbounded.
        await closeQuietly(stream);
        return {
          status: "unknown",
          message: "the Tangle terminal transport reported no detach window",
          retryable: false,
        };
      }
      let info: SandboxTerminalInfoLike | null;
      try {
        info = await awaitWithSignal(
          terminals.get(acknowledgement.sessionId),
          options?.signal,
        );
      } catch (error) {
        options?.signal?.throwIfAborted();
        await closeQuietly(stream);
        return {
          status: "unknown",
          message: transportFailureReason("terminal metadata read", error),
          retryable: true,
        };
      }
      if (info === null || info === undefined) {
        await closeQuietly(stream);
        return {
          status: "unknown",
          message: "the Tangle runtime reported no metadata for the attached terminal",
          retryable: true,
        };
      }
      const state = terminalStateFromInfo(
        info,
        acknowledgement,
        exactRequest.parentExecutionId,
        activity.localMs,
      );
      if (typeof state === "string") {
        await closeQuietly(stream);
        return { status: "unknown", message: state, retryable: false };
      }
      const previous = attached.get(state.terminalSessionId);
      state.attachCount =
        previous === undefined ? 1 : previous.session.ref.attachCount + 1;
      // A handle drops only the entry it still owns, matched by the socket it
      // was built on. A later attach replaces that entry with its own socket,
      // so a stale handle's detach cannot evict the terminal now held.
      const release = (): void => {
        if (attached.get(state.terminalSessionId)?.stream === stream) {
          attached.delete(state.terminalSessionId);
        }
      };
      const session = createTangleTerminalSession(
        stream,
        log,
        state,
        activity,
        exit,
        release,
      );
      attached.set(state.terminalSessionId, { session, stream });
      // The registry holds one socket per terminal. The socket this attach
      // replaces stays open on the runtime until its own close, so it is
      // closed here rather than abandoned with the handle that owned it.
      if (previous !== undefined) await closeQuietly(previous.stream);
      return {
        status: acknowledgement.restored === true ? "reattached" : "attached",
        mode: "attach",
        ref: session.ref,
        attachCount: state.attachCount,
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
