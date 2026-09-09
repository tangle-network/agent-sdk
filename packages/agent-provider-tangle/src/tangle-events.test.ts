import { readFileSync } from "node:fs";
import type { SandboxEvent } from "@tangle-network/sandbox";
import { AgentTurnResultSchema, type AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import { createTangleProvider } from "./index.js";
import { assertBoundedJson } from "./tangle-contract-safety.js";
import { environmentEventFromSandboxEvent } from "./tangle-events.js";
import { controlRefForTurn, retainedDeployment } from "./retained-control-test-helpers.js";
import type { SandboxSessionLike } from "./index.js";
import { validatedSandboxPromptResult } from "./tangle-prompt.js";

const recordedOutput = readFileSync(
  new URL("../test/fixtures/codex-tool-output-redacted.txt", import.meta.url),
  "utf8",
);

function toolEvent(output: string): SandboxEvent {
  return {
    type: "message.part.updated",
    id: "event-tool-completed",
    data: {
      executionId: "execution-1",
      sessionId: "session-1",
      part: {
        id: "item-1", sessionID: "session-1", messageID: "message-1",
        type: "tool", callID: "item-1", tool: "shell",
        state: {
          status: "completed", input: { command: "read documentation" },
          output, time: { start: 1, end: 2 },
        },
      },
    },
  };
}

const bound = { executionId: "execution-1", sessionId: "session-1" };

describe("Sandbox stream event content", () => {
  it("preserves retained long Codex tool output through the provider stream", async () => {
    expect(recordedOutput.length).toBe(17_511);
    const event = toolEvent(recordedOutput);
    const provider = createTangleProvider({
      client: {
        async create() {
          return {
            id: "sandbox-fixture", status: "running",
            async *streamPrompt() {
              yield event;
              yield { type: "done", id: "event-done", data: { status: "success", usage: { inputTokens: 21, outputTokens: 3 } } };
            },
          };
        },
      },
    });
    const environment = await provider.create({ profile: { name: "fixture" } });
    const events: AgentEnvironmentEvent[] = [];
    for await (const entry of environment.stream({ prompt: "inspect documentation" })) events.push(entry);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: event.id, data: event.data, normalized: { type: event.type, part: event.data.part } });
    expect(events[0]?.providerEvent).toEqual(event);
    expect(events[1]?.usage).toEqual({ inputTokens: 21, outputTokens: 3 });
    expect(() => AgentTurnResultSchema.parse({ text: "done", success: true, events })).not.toThrow();
  });

  it("preserves cumulative assistant text and terminal content", () => {
    const part = { id: "text-1", sessionID: "session-1", messageID: "message-1", type: "text", text: recordedOutput };
    const textEvent = environmentEventFromSandboxEvent({ type: "message.part.updated", data: { part } });
    expect(textEvent.normalized).toEqual({ type: "message.part.updated", part });
    const terminal = environmentEventFromSandboxEvent({ type: "done", data: { finalText: recordedOutput } });
    expect(terminal.data.finalText).toBe(recordedOutput);
    expect(terminal.usage).toBeUndefined();
    expect(() => AgentTurnResultSchema.parse({ text: recordedOutput, success: true, events: [textEvent, terminal] })).not.toThrow();
  });

  it("retains a long final response through exact-session result readback", async () => {
    const nativeSession: SandboxSessionLike = {
      id: "session-result",
      async status() { return { status: "completed" }; },
      async *events() {},
      async prompt() { throw new Error("readback must not start a turn"); },
      async interrupt() { throw new Error("readback must not interrupt a turn"); },
      async result(options) {
        return {
          success: true, status: "success", executionId: options?.executionId,
          response: recordedOutput, durationMs: 1,
          usage: { inputTokens: 21, outputTokens: 3 },
        };
      },
    };
    const box = retainedDeployment({
      id: "sandbox-result", async *streamPrompt() {}, session: () => nativeSession,
    });
    const provider = createTangleProvider({ client: { async create() { return box; } } });
    const environment = await provider.create({ profile: { name: "fixture" } });
    const controlRef = controlRefForTurn({ prompt: "research", turnId: "turn-result" }, box.id, nativeSession.id);
    const session = environment.session!(nativeSession.id, { controlRef });
    const result = await session.result();
    expect(result.text).toBe(recordedOutput);
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 3 });
    expect(() => AgentTurnResultSchema.parse(result)).not.toThrow();
  });

  it("counts the complete serialized UTF-8 frame, including escaping and keys", () => {
    const empty = toolEvent("");
    const remaining = 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty), "utf8");
    expect(() => environmentEventFromSandboxEvent(toolEvent("x".repeat(remaining)), bound)).not.toThrow();
    expect(() => environmentEventFromSandboxEvent(toolEvent("x".repeat(remaining + 1)), bound)).toThrow(/JSON content bound/);
    for (const value of ["😀", "\u0000"]) {
      const escapedBytes = Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
      const fits = value.repeat(Math.floor(remaining / escapedBytes));
      expect(() => environmentEventFromSandboxEvent(toolEvent(fits), bound)).not.toThrow();
      expect(() => environmentEventFromSandboxEvent(toolEvent(fits + value), bound)).toThrow(/JSON content bound/);
    }
    const manyStrings = { type: "raw", data: { first: "x".repeat(600_000), second: "x".repeat(600_000) } };
    expect(() => environmentEventFromSandboxEvent(manyStrings)).toThrow(/JSON content bound/);
  });

  it("retains identity, JSON-shape, and metadata restrictions", () => {
    expect(() => environmentEventFromSandboxEvent(toolEvent(recordedOutput), { ...bound, sessionId: "foreign" })).toThrow(/different sessionId/);
    expect(() => environmentEventFromSandboxEvent({ type: "raw", data: { value: Infinity } })).toThrow(/JSON content bound/);
    expect(() => environmentEventFromSandboxEvent({ type: "raw", data: { value: new Array(1025).fill(null) } })).toThrow(/JSON content bound/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => environmentEventFromSandboxEvent({ type: "raw", data: cyclic })).toThrow(/JSON content bound/);
    expect(() => environmentEventFromSandboxEvent({ type: "raw", data: { value: new Date() } })).toThrow(/JSON content bound/);
    expect(() => assertBoundedJson(recordedOutput)).toThrow(/JSON bound/);
    expect(() => environmentEventFromSandboxEvent({ type: "raw", data: { usage: { inputTokens: 2, outputTokens: 3, note: recordedOutput } } })).toThrow(/JSON bound/);
    expect(() => environmentEventFromSandboxEvent({ type: "raw", data: { usage: { inputTokens: 2, outputTokens: 3 }, costUsd: -1 } })).toThrow(/result cost/);
    const result = { success: true, status: "success" as const, durationMs: 1, response: recordedOutput };
    expect(() => validatedSandboxPromptResult({ ...result, response: "x".repeat(1024 * 1024) })).toThrow(/JSON bound/);
    expect(() => validatedSandboxPromptResult({ ...result, traceId: recordedOutput })).toThrow(/JSON bound/);
    expect(() => validatedSandboxPromptResult({ ...result, usage: { inputTokens: 2, outputTokens: -1 } })).toThrow(/output token count/);
  });
});
