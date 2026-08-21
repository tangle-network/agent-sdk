import { describe, expect, it } from "vitest";
import {
  commandTurnEvents,
  execOnlyEnvironmentCapabilities,
  execResultFromUnknown,
} from "./environment-command-turn.js";
import type { AgentEnvironment, AgentEnvironmentEvent } from "./environment-runtime.js";
import type { ExecRequest, ExecResult } from "./environment-requests.js";

const SOURCE = "Test sandbox exec";

function environmentRunning(
  exec: (command: string, request?: ExecRequest) => Promise<ExecResult>,
): { environment: AgentEnvironment; commands: string[] } {
  const commands: string[] = [];
  const environment: AgentEnvironment = {
    id: "environment-1",
    provider: "test",
    status: async () => "running",
    async *stream() {},
    async exec(command, request) {
      commands.push(command);
      return exec(command, request);
    },
  };
  return { environment, commands };
}

async function drain(
  events: AsyncIterable<AgentEnvironmentEvent>,
): Promise<AgentEnvironmentEvent[]> {
  const seen: AgentEnvironmentEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("execResultFromUnknown", () => {
  it("reads either name a sandbox SDK gives each of the three facts", () => {
    expect(
      execResultFromUnknown({ exitCode: 3, stdout: "out", stderr: "err" }, SOURCE),
    ).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
    expect(
      execResultFromUnknown({ code: 3, output: "out", error: "err" }, SOURCE),
    ).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
  });

  it("prefers the primary name when a result carries both", () => {
    expect(
      execResultFromUnknown(
        {
          exitCode: 1,
          code: 9,
          stdout: "primary",
          output: "alias",
          stderr: "primary-error",
          error: "alias-error",
        },
        SOURCE,
      ),
    ).toEqual({ exitCode: 1, stdout: "primary", stderr: "primary-error" });
  });

  it("reads captured output only from a string, never from another type", () => {
    expect(
      execResultFromUnknown({ exitCode: 0, stdout: 5, stderr: null }, SOURCE),
    ).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("refuses a result with no exit status instead of reading it as success", () => {
    for (const [label, value] of [
      ["nothing at all", undefined],
      ["output but no status", { stdout: "built ok" }],
      ["a non-numeric status", { exitCode: "1" }],
      ["a non-finite status", { exitCode: Number.NaN }],
    ] as const) {
      expect(() => execResultFromUnknown(value, SOURCE), label).toThrow(
        `${SOURCE} returned no exit status: a command result must carry a finite exitCode or code`,
      );
    }
  });

  it("accepts a zero exit status, which is a measured success", () => {
    expect(execResultFromUnknown({ exitCode: 0 }, SOURCE)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });
});

describe("commandTurnEvents", () => {
  it("takes the caller's turn command ahead of provider options and the prompt", async () => {
    const { environment, commands } = environmentRunning(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));
    await drain(
      commandTurnEvents({
        input: {
          prompt: "prompt-command",
          providerOptions: { command: "options-command" },
        },
        environment,
        providerLabel: "Test",
        turnCommand: () => "turn-command",
      }),
    );
    expect(commands).toEqual(["turn-command"]);
  });

  it("falls to providerOptions.command, then agentCommand, then the prompt", async () => {
    const runs: string[] = [];
    for (const providerOptions of [
      { command: "options-command", agentCommand: "agent-command" },
      { agentCommand: "agent-command" },
      {},
    ]) {
      const { environment, commands } = environmentRunning(async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }));
      await drain(
        commandTurnEvents({
          input: { prompt: "prompt-command", providerOptions },
          environment,
          providerLabel: "Test",
        }),
      );
      runs.push(...commands);
    }
    expect(runs).toEqual(["options-command", "agent-command", "prompt-command"]);
  });

  it("refuses the turn instead of running an empty command", async () => {
    const { environment, commands } = environmentRunning(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    await expect(
      drain(
        commandTurnEvents({
          input: { providerOptions: { command: "" } },
          environment,
          providerLabel: "Test",
        }),
      ),
    ).rejects.toThrow(
      "Test provider requires turnCommand, providerOptions.command, or prompt",
    );
    expect(commands).toEqual([]);
  });

  it("reports a non-zero exit as a failed turn and carries stderr", async () => {
    const { environment } = environmentRunning(async () => ({
      exitCode: 2,
      stdout: "partial",
      stderr: "boom",
    }));
    const events = await drain(
      commandTurnEvents({
        input: { prompt: "run" },
        environment,
        providerLabel: "Test",
      }),
    );
    expect(events).toEqual([
      { type: "message.part.updated", data: { delta: "partial" } },
      {
        type: "result",
        data: {
          finalText: "partial",
          status: "failed",
          exitCode: 2,
          stderr: "boom",
        },
      },
    ]);
  });

  it("passes the turn timeout, signal, and provider cwd to exec", async () => {
    const controller = new AbortController();
    let seen: ExecRequest | undefined;
    const { environment } = environmentRunning(async (_command, request) => {
      seen = request;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await drain(
      commandTurnEvents({
        input: {
          prompt: "run",
          timeoutMs: 1_000,
          signal: controller.signal,
          providerOptions: { cwd: "/work" },
        },
        environment,
        providerLabel: "Test",
      }),
    );
    expect(seen).toEqual({
      cwd: "/work",
      timeoutMs: 1_000,
      signal: controller.signal,
    });
  });
});

describe("execOnlyEnvironmentCapabilities", () => {
  it("claims no agent-profile, streaming, session, or branching surface", () => {
    expect(
      execOnlyEnvironmentCapabilities({
        read: true,
        write: true,
        exec: true,
        git: false,
        upload: true,
        download: true,
      }),
    ).toEqual({
      profile: {
        namedProfiles: false,
        systemPrompt: { replace: false, append: false },
        instructions: false,
        tools: false,
        permissions: false,
        mcp: false,
        subagents: false,
        resources: {
          files: true,
          instructions: false,
          tools: false,
          skills: false,
          agents: false,
          commands: false,
        },
        hooks: false,
        modes: false,
        runtimeUpdate: false,
        validation: false,
      },
      streaming: {
        live: false,
        replay: false,
        detach: false,
        turnIdempotency: false,
      },
      sessions: { continue: false, list: false, messages: false },
      workspace: {
        read: true,
        write: true,
        exec: true,
        git: false,
        upload: true,
        download: true,
      },
      branching: { checkpoint: false, fork: false },
      placement: true,
      usage: false,
      confidential: false,
    });
  });

  it("carries the caller's workspace facts rather than a shared default", () => {
    const capabilities = execOnlyEnvironmentCapabilities({
      read: true,
      write: false,
      exec: true,
      git: true,
      upload: false,
      download: false,
    });
    expect(capabilities.workspace).toEqual({
      read: true,
      write: false,
      exec: true,
      git: true,
      upload: false,
      download: false,
    });
  });
});
