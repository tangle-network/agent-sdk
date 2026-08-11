import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import {
  retainedEventsWithIdentity,
  retainedReplayRequest,
} from "./retained-event-cursor.js";

describe("retained event cursor", () => {
  it("replays the source frame and skips only committed subevents", () => {
    const events: AgentEnvironmentEvent[] = [
      { type: "usage", data: {}, usage: { inputTokens: 2, outputTokens: 1 } },
      {
        type: "message.part.updated",
        data: {},
        normalized: {
          type: "message.part.updated",
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            text: "done",
          },
          delta: "done",
        },
      },
      {
        type: "result",
        data: { finalText: "done", finishReason: "stop", status: "completed" },
      },
    ];
    const replay = retainedReplayRequest("7:0");

    expect(replay.serverCursor).toBe("6");
    expect(
      Array.from(
        retainedEventsWithIdentity(
          events,
          "7",
          "run-1",
          "session-1",
          "execution-1",
          replay.anchor,
        ),
      ).map((event) => ({ id: event.id, cursor: event.data.cursor })),
    ).toEqual([
      { id: "7:1", cursor: "7:1" },
      { id: "7:2", cursor: "7:2" },
    ]);
  });

  it("keeps the server start cursor compatible", () => {
    expect(retainedReplayRequest("0")).toEqual({ serverCursor: "0" });
  });

  it("fails closed for cursors the server cannot replay exactly", () => {
    expect(() => retainedReplayRequest("7.1")).toThrow("replay cursor is invalid");
    expect(() => retainedReplayRequest("0:0")).toThrow("frame must be positive");
  });
});
