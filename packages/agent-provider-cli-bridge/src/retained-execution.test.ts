import {
  AgentExactRunControlRefSchema,
  AgentTurnResultSchema,
} from "@tangle-network/agent-interface";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import { collectCliBridgeTurnResult } from "./retained-execution.js";
import type { CliBridgeRun } from "./retained-run-state.js";
import type { CliBridgeTransport } from "./transport.js";

describe("retained turn results", () => {
  it("keeps full aggregates and a contract-valid event tail for a long replay", async () => {
    const run = retainedRun();
    const result = await collectCliBridgeTurnResult(
      replayEvents(2_040),
      run,
      { baseUrl: "http://bridge.local" },
      terminalTransport(run),
    );

    expect(AgentTurnResultSchema.safeParse(result).success).toBe(true);
    expect(result.text).toHaveLength(2_040);
    expect(result.usage).toEqual({ inputTokens: 2_040, outputTokens: 2_040 });
    expect(result.events).toHaveLength(1_024);
    expect(result.events?.[0]?.id).toBe("event-1016");
    expect(result.events?.at(-1)?.id).toBe("event-2039");
  });
});

async function* replayEvents(count: number): AsyncIterable<AgentEnvironmentEvent> {
  for (let index = 0; index < count; index += 1) {
    yield {
      id: `event-${index}`,
      type: "text",
      data: { delta: "x" },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function retainedRun(): CliBridgeRun {
  return {
    id: "run-result-window",
    provider: "cli-bridge",
    environmentId: "environment-result-window",
    sessionId: "session-result-window",
    executionId: "execution-result-window",
    turnId: "turn-result-window",
    requestBody: "",
    readers: new Set<AbortController>(),
    requestDigest: AgentExactRunControlRefSchema.shape.requestDigest.parse(
      `sha256:${"a".repeat(64)}`,
    ),
  };
}

function terminalTransport(run: CliBridgeRun): CliBridgeTransport {
  return {
    async fetch() {
      const value = JSON.stringify({
        id: run.id,
        provider: run.provider,
        environmentId: run.environmentId,
        sessionId: run.sessionId,
        executionId: run.executionId,
        requestDigest: run.requestDigest,
        status: "done",
        terminal: true,
      });
      const bytes = new TextEncoder().encode(value);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
        text: async () => value,
      };
    },
    close: async () => {},
  };
}
