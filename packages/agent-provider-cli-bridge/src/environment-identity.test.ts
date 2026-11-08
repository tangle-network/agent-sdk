import { describe, expect, it } from "vitest";
import { canonicalCandidateDigest } from "@tangle-network/agent-interface";
import {
  cliBridgeEnvironmentId,
  cliBridgeEnvironmentRoute,
} from "./environment-identity.js";

describe("cli-bridge environment identity", () => {
  it("retains the exact route across provider instances", () => {
    const route = { backend: "pi", model: "pi/tangle-router/glm-5.2" };
    const createDigest = canonicalCandidateDigest("stable-create-input");
    const first = cliBridgeEnvironmentId(route, createDigest, "stable-create");
    const second = cliBridgeEnvironmentId(route, createDigest, "stable-create");

    expect(second).toBe(first);
    expect(first).toMatch(/^cb1\./u);
    expect(cliBridgeEnvironmentRoute(first)).toEqual({ ...route, createDigest });
  });

  it("rejects a caller-owned plain identity", () => {
    expect(() => cliBridgeEnvironmentRoute("plain-environment")).toThrow(
      "not a provider-owned retained identity",
    );
  });

  it.each([
    "cb1.",
    "cb1.not-base64!",
    `cb1.${Buffer.from(JSON.stringify(["pi", "pi/model", "bad-digest", "nonce"])).toString("base64url")}`,
    `cb1.${Buffer.from(JSON.stringify(["pi", null, canonicalCandidateDigest("create"), "nonce"])).toString("base64url")}`,
    `cb1.${Buffer.from(JSON.stringify(["pi", "codex/model", canonicalCandidateDigest("create"), "nonce"])).toString("base64url")}`,
    `cb1.${"a".repeat(600)}`,
  ])("rejects malformed retained identity %s", (id) => {
    expect(() => cliBridgeEnvironmentRoute(id)).toThrow(
      "invalid retained route data",
    );
  });
});
