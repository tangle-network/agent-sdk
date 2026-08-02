import { describe, expect, it } from "vitest";
import { AgentEnvironmentCapabilitiesSchema } from "./environment-provider.js";

const capabilities = {
  profile: {
    namedProfiles: true,
    systemPrompt: true,
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: { files: true, instructions: true },
    runtimeUpdate: true,
    validation: true,
  },
  streaming: {
    live: true,
    replay: true,
    detach: true,
    turnIdempotency: true,
  },
  sessions: { continue: true, list: true, messages: true },
  workspace: {
    read: true,
    write: true,
    exec: true,
    git: true,
    upload: true,
    download: true,
  },
  branching: {
    checkpoint: true,
    fork: true,
    retrySafe: true,
    lookup: true,
    cleanup: true,
  },
  placement: true,
  usage: true,
  confidential: false,
  exactProcess: { egress: ["blocked", "strict"] as const },
};

describe("AgentEnvironmentCapabilitiesSchema", () => {
  it("accepts a complete strict capability document", () => {
    expect(AgentEnvironmentCapabilitiesSchema.parse(capabilities)).toEqual(
      capabilities,
    );
  });

  it("rejects malformed booleans and unknown capability fields", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        workspace: { ...capabilities.workspace, read: "yes" },
      }),
    ).toThrow();
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        providerNativeBypass: true,
      }),
    ).toThrow();
  });

  it("requires durable branching features to be all-or-nothing", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        branching: {
          ...capabilities.branching,
          cleanup: false,
        },
      }),
    ).toThrow(/requires checkpoint, fork, lookup, and cleanup together/);
  });

  it("rejects duplicate open capability values", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        profile: {
          ...capabilities.profile,
          extensions: ["vendor", "vendor"],
        },
      }),
    ).toThrow(/extension namespaces must be unique/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        exactProcess: { egress: ["blocked", "blocked"] },
      }),
    ).toThrow(/egress modes must be unique/);
  });
});
