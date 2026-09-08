import { describe, expect, it } from "vitest";
import { AgentRuntimeAttachmentsSchema } from "./index.js";
import { agentEnvironmentCreateInputDigest } from "./environment-runtime.js";

const attachments = {
  mcp: {
    coordination: {
      transport: "http" as const,
      url: "https://coordinator.example/mcp/actor",
      headers: { Authorization: { kind: "secret-ref" as const, key: "AGENT_RUNTIME_COORDINATION_TOKEN", format: "bearer" as const } },
    },
  },
};

describe("runtime-owned MCP attachments", () => {
  it("uses the canonical MCP value contract and refuses unknown attachment kinds", () => {
    expect(AgentRuntimeAttachmentsSchema.parse(attachments)).toEqual(attachments);
    expect(AgentRuntimeAttachmentsSchema.safeParse({ ...attachments, profile: {} }).success).toBe(false);
    expect(AgentRuntimeAttachmentsSchema.safeParse({ mcp: { coordination: {
      ...attachments.mcp.coordination, headers: { Authorization: "Bearer fixture" },
    } } }).success).toBe(false);
  });

  it("preserves own MCP aliases without changing the object prototype", () => {
    const mcp = JSON.parse(JSON.stringify({
      ["__proto__"]: attachments.mcp.coordination,
      constructor: attachments.mcp.coordination,
    }));
    const parsed = AgentRuntimeAttachmentsSchema.parse({ mcp });
    expect(Object.keys(parsed.mcp)).toEqual(["__proto__", "constructor"]);
    expect(Object.hasOwn(parsed.mcp, "__proto__")).toBe(true);
    expect(parsed.mcp["__proto__"]).toEqual(attachments.mcp.coordination);
    expect(Object.getPrototypeOf(parsed.mcp)).toBe(Object.prototype);
  });

  it("binds endpoint and credential changes to create identity without mutating the profile", () => {
    const profile = Object.freeze({ name: "authored" });
    const input = { profile, runtimeAttachments: attachments, env: { AGENT_RUNTIME_COORDINATION_TOKEN: "fixture" }, idempotencyKey: "create" };
    const digest = agentEnvironmentCreateInputDigest(input);
    for (const server of [
      { ...attachments.mcp.coordination, url: "https://coordinator.example/mcp/other" },
      { ...attachments.mcp.coordination, headers: { Authorization: { kind: "secret-ref" as const, key: "AGENT_RUNTIME_OTHER_TOKEN", format: "bearer" as const } } },
    ]) {
      expect(agentEnvironmentCreateInputDigest({ ...input, runtimeAttachments: { mcp: { coordination: server } } })).not.toBe(digest);
    }
    expect(agentEnvironmentCreateInputDigest({ ...input, env: { AGENT_RUNTIME_COORDINATION_TOKEN: "rotated" } })).not.toBe(digest);
    expect(profile).toEqual({ name: "authored" });
    expect(agentEnvironmentCreateInputDigest({ ...input, idempotencyKey: "other" })).toBe(digest);
  });
});
