import { describe, expect, it } from "vitest";
import {
  TerminalAttachRequestSchema,
  TerminalAttachResultSchema,
  TerminalDetachAckSchema,
  TerminalInputSchema,
  TerminalOutputEventSchema,
  TerminalResizeSchema,
  TerminalSessionRefSchema,
  terminalAttachResultMatchesRequest,
  terminalSessionUsable,
  type TerminalSessionRef,
} from "./environment-terminal.js";

function makeRef(): TerminalSessionRef {
  return {
    terminalSessionId: "term-1",
    parentExecutionId: "execution-1",
    name: "shell",
    shell: "/bin/bash",
    command: "top",
    cwd: "/workspace",
    cols: 120,
    rows: 40,
    connectionId: "connection-1",
    createdAt: "2026-08-12T10:00:00.000Z",
    lastActivityAt: "2026-08-12T10:05:00.000Z",
    expiresAt: "2026-08-12T12:00:00.000Z",
    isRunning: true,
    attachCount: 1,
  };
}

describe("TerminalSessionRefSchema", () => {
  it("parses a terminal reference", () => {
    const ref = makeRef();
    expect(TerminalSessionRefSchema.parse(ref)).toEqual(ref);
  });

  it("rejects an environment map or a raw process id", () => {
    expect(TerminalSessionRefSchema.safeParse({ ...makeRef(), pid: 1234 }).success).toBe(
      false,
    );
    expect(
      TerminalSessionRefSchema.safeParse({ ...makeRef(), env: { SECRET: "x" } }).success,
    ).toBe(false);
  });

  it("requires the parent execution and an expiry", () => {
    const { parentExecutionId, ...noParent } = makeRef();
    void parentExecutionId;
    expect(TerminalSessionRefSchema.safeParse(noParent).success).toBe(false);
    const { expiresAt, ...noExpiry } = makeRef();
    void expiresAt;
    expect(TerminalSessionRefSchema.safeParse(noExpiry).success).toBe(false);
  });

  it("rejects a non-positive geometry", () => {
    expect(TerminalSessionRefSchema.safeParse({ ...makeRef(), cols: 0 }).success).toBe(
      false,
    );
    expect(TerminalSessionRefSchema.safeParse({ ...makeRef(), rows: -1 }).success).toBe(
      false,
    );
  });
});

describe("terminal input and resize bounds", () => {
  it("accepts input bytes and a valid resize", () => {
    expect(TerminalInputSchema.parse({ data: "ls -la\n" }).data).toBe("ls -la\n");
    expect(TerminalResizeSchema.parse({ cols: 80, rows: 24 })).toEqual({
      cols: 80,
      rows: 24,
    });
  });

  it("rejects a non-positive or oversized resize", () => {
    expect(TerminalResizeSchema.safeParse({ cols: 0, rows: 24 }).success).toBe(false);
    expect(TerminalResizeSchema.safeParse({ cols: 80, rows: 100_000 }).success).toBe(false);
  });
});

describe("TerminalOutputEventSchema", () => {
  it("orders output frames with a replay cursor", () => {
    expect(TerminalOutputEventSchema.parse({ type: "ready", cols: 120, rows: 40 }).type).toBe(
      "ready",
    );
    const output = TerminalOutputEventSchema.parse({
      type: "output",
      seq: 7,
      data: "hello",
    });
    expect(output).toMatchObject({ type: "output", seq: 7 });
    expect(TerminalOutputEventSchema.parse({ type: "exit", exitCode: 0 }).type).toBe("exit");
    expect(
      TerminalOutputEventSchema.parse({ type: "error", message: "pty closed" }).type,
    ).toBe("error");
  });

  it("requires the replay cursor on an output frame", () => {
    expect(TerminalOutputEventSchema.safeParse({ type: "output", data: "x" }).success).toBe(
      false,
    );
  });
});

describe("TerminalAttachResultSchema", () => {
  const request = {
    parentExecutionId: "execution-1",
    terminalSessionId: "term-1",
    mode: "attach" as const,
    cols: 120,
    rows: 40,
  };

  it("parses each attach outcome", () => {
    expect(TerminalAttachRequestSchema.parse(request)).toEqual(request);
    const attached = TerminalAttachResultSchema.parse({
      status: "reattached",
      mode: "attach",
      ref: makeRef(),
      attachCount: 2,
    });
    expect(attached.status).toBe("reattached");
    expect(
      TerminalAttachResultSchema.parse({
        status: "unavailable",
        reason: "terminal expired",
      }).status,
    ).toBe("unavailable");
    expect(
      TerminalAttachResultSchema.parse({
        status: "unknown",
        message: "transport failed",
        retryable: true,
      }).status,
    ).toBe("unknown");
  });

  it("binds an attach result to the requested parent execution and terminal", () => {
    const result = {
      status: "reattached" as const,
      mode: "attach" as const,
      ref: makeRef(),
      attachCount: 2,
    };
    expect(terminalAttachResultMatchesRequest(request, result)).toBe(true);
    expect(
      terminalAttachResultMatchesRequest(request, {
        ...result,
        ref: { ...makeRef(), parentExecutionId: "execution-9" },
      }),
    ).toBe(false);
    expect(
      terminalAttachResultMatchesRequest(request, { ...result, mode: "logical" }),
    ).toBe(false);
    expect(
      terminalAttachResultMatchesRequest(request, {
        status: "unavailable",
        reason: "gone",
      }),
    ).toBe(false);
  });
});

describe("TerminalDetachAckSchema", () => {
  it("parses detach and close acknowledgements", () => {
    expect(
      TerminalDetachAckSchema.parse({
        status: "detached",
        terminalSessionId: "term-1",
        connectionId: "connection-1",
      }).status,
    ).toBe("detached");
    expect(
      TerminalDetachAckSchema.parse({
        status: "closed",
        terminalSessionId: "term-1",
        exitCode: 0,
      }).status,
    ).toBe("closed");
  });
});

describe("terminalSessionUsable", () => {
  it("fails closed for an expired, stopped, or unparseable terminal", () => {
    const ref = makeRef();
    expect(terminalSessionUsable(ref, "2026-08-12T11:00:00.000Z")).toBe(true);
    expect(terminalSessionUsable(ref, "2026-08-12T12:00:00.000Z")).toBe(false);
    expect(terminalSessionUsable(ref, "2026-08-12T13:00:00.000Z")).toBe(false);
    expect(terminalSessionUsable({ ...ref, isRunning: false }, "2026-08-12T11:00:00.000Z")).toBe(
      false,
    );
    expect(
      terminalSessionUsable({ ...ref, expiresAt: "not-a-date" }, "2026-08-12T11:00:00.000Z"),
    ).toBe(false);
  });
});
