import { describe, expect, it } from "vitest";
import { transportFailureReason } from "./tangle-failure-reason.js";

describe("transportFailureReason", () => {
  it("keeps bounded HTTP status and service code without carrying the transport message", () => {
    const error = Object.assign(
      new Error("https://agent:secret@runtime.example failed"),
      { status: 409, code: "SESSION_DELETING" },
    );

    const reason = transportFailureReason("interactive start", error);

    expect(reason).toBe(
      "the Sandbox interactive start failed (HTTP 409; code SESSION_DELETING)",
    );
    expect(reason).not.toContain("secret");
  });
});
