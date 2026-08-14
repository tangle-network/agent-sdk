import { describe, expect, it } from "vitest";
import type { StatusEvent } from "../src/types/events.js";

describe("StatusEvent", () => {
  it("keeps caller cancellation distinct from failure", () => {
    const event = {
      type: "status",
      status: "cancelled",
      detail: "run cancelled by caller",
    } satisfies StatusEvent;

    expect(event).toEqual({
      type: "status",
      status: "cancelled",
      detail: "run cancelled by caller",
    });
  });
});
