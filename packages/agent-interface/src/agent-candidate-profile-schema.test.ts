import { describe, expect, it } from "vitest";
import { agentCandidateProfileSchema } from "./agent-candidate-profile-schema.js";

describe("agentCandidateProfileSchema", () => {
  it("rejects unknown nested behavior instead of stripping it", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        model: { default: "openai/gpt-5.4", futureBehaviorKnob: "on" },
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("allows only public local process configuration", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        mcp: {
          local: {
            transport: "stdio",
            command: "local-mcp",
            args: [{ kind: "public", value: "--read-only" }],
          },
        },
        hooks: {
          beforeRun: [
            {
              executable: "prepare-agent",
              args: [{ kind: "public", value: "--offline" }],
            },
          ],
        },
      }),
    ).not.toThrow();

    expect(() =>
      agentCandidateProfileSchema.parse({
        hooks: {
          beforeRun: [
            {
              executable: "prepare-agent",
              args: [{ kind: "secret", name: "PREPARE_TOKEN" }],
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      agentCandidateProfileSchema.parse({
        mcp: {
          github: {
            args: [{ kind: "public", value: "--token=sk-live-abcdefghijkl" }],
          },
        },
      }),
    ).toThrow(/cannot carry credentials/);
  });

  it("forbids remote MCP and process fields on disabled entries", () => {
    for (const server of [
      { transport: "stdio", url: { kind: "https", url: "https://mcp.example/api" } },
      { transport: "http", command: "local-mcp" },
      { transport: "sse" },
      { command: "local-mcp", headers: { Authorization: { kind: "secret", name: "TOKEN" } } },
      { enabled: false, transport: "stdio", command: "local-mcp" },
    ]) {
      expect(() =>
        agentCandidateProfileSchema.parse({ mcp: { invalid: server } }),
      ).toThrow();
    }
    expect(() =>
      agentCandidateProfileSchema.parse({
        mcp: { disabled: { enabled: false } },
      }),
    ).not.toThrow();
  });

  it("rejects arbitrary backend extensions in a frozen profile", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        extensions: { provider: { auth: "sk-live-abcdefghijkl" } },
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("rejects obvious private or credential-bearing MCP endpoints", () => {
    for (const url of [
      "http://mcp.example/api",
      "https://user:password@mcp.example/api",
      "https://127.0.0.1/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/computeMetadata/v1",
      "https://mcp.example/api?token=plaintext",
      "https://mcp.example/secrets/sk-live-abcdefghijkl",
    ]) {
      expect(() =>
        agentCandidateProfileSchema.parse({
          mcp: { remote: { url: { kind: "https", url } } },
        }),
      ).toThrow();
    }
  });

  it("rejects all candidate-authored metadata and ambient connections", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        metadata: { nested: { database_url: "plaintext" } },
      }),
    ).toThrow(/Unrecognized key/);
    expect(() =>
      agentCandidateProfileSchema.parse({
        connections: [
          { connectionId: "ambient-github", capabilities: ["repo.write"] },
        ],
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("requires every explicit model route to use the primary literal", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        model: { default: "openai/gpt-5.4", small: "openai/gpt-5.4" },
        subagents: { reviewer: { model: "openai/gpt-5.4" } },
        modes: { planning: { model: "openai/gpt-5.4" } },
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateProfileSchema.parse({
        model: { default: "openai/gpt-5.4", small: "openai/gpt-5-mini" },
      }),
    ).toThrow(/exact primary model/);
    expect(() =>
      agentCandidateProfileSchema.parse({
        subagents: { reviewer: { model: "openai/gpt-5.4" } },
      }),
    ).toThrow(/exact primary model/);
  });

  it("rejects model routes and subagent limits that cannot execute", () => {
    for (const profile of [
      { model: { default: "" } },
      { model: { provider: "" } },
      { model: { default: "openai/gpt-5.4", small: "" } },
      { subagents: { reviewer: { maxSteps: 0 } } },
      { subagents: { reviewer: { maxSteps: 1.5 } } },
      { modes: { review: { model: "" } } },
    ]) {
      expect(() => agentCandidateProfileSchema.parse(profile)).toThrow();
    }
  });

  it("rejects lone surrogates even through generic profile sub-schemas", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        prompt: { systemPrompt: "\ud800" },
      }),
    ).toThrow(/RFC 8785/);
  });
});
