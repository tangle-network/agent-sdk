import { CanonicalStreamEventSchema } from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import type { StatusEvent } from "../src/types/events.js";

// The canonical contract owns the status vocabulary. The satisfies clause fails
// to compile if this package drops a status, and the parse fails if the contract
// drops one, so the two vocabularies cannot drift apart in either direction.
const canonicalStatuses = [
  "started",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly StatusEvent["status"][];

describe("StatusEvent", () => {
  it("carries every canonical status, caller cancellation included", () => {
    for (const status of canonicalStatuses) {
      const event = { type: "status", status } satisfies StatusEvent;
      expect(CanonicalStreamEventSchema.parse(event)).toEqual(event);
    }
  });

  it("keeps caller cancellation distinct from failure", () => {
    const cancelled = {
      type: "status",
      status: "cancelled",
      detail: "run cancelled by caller",
    } satisfies StatusEvent;
    const failed = {
      type: "status",
      status: "failed",
      detail: "run cancelled by caller",
    } satisfies StatusEvent;

    expect(CanonicalStreamEventSchema.parse(cancelled)).not.toEqual(
      CanonicalStreamEventSchema.parse(failed),
    );
  });
});
