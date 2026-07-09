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

  it("uses secret refs in environment, headers, MCP args, and hook args", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        mcp: {
          github: {
            transport: "http",
            url: { kind: "https", url: "https://mcp.example/api" },
            headers: {
              Authorization: { kind: "secret", name: "GITHUB_TOKEN" },
            },
            args: [
              { kind: "public", value: "--token" },
              { kind: "secret", name: "GITHUB_TOKEN" },
            ],
          },
        },
        hooks: {
          beforeRun: [
            {
              executable: "prepare-agent",
              args: [{ kind: "secret", name: "PREPARE_TOKEN" }],
            },
          ],
        },
      }),
    ).not.toThrow();

    expect(() =>
      agentCandidateProfileSchema.parse({
        mcp: {
          github: {
            headers: {
              Authorization: { kind: "public", value: "Bearer plaintext-token" },
            },
          },
        },
      }),
    ).toThrow(/secret reference/);
    expect(() =>
      agentCandidateProfileSchema.parse({
        mcp: {
          github: {
            args: [{ kind: "public", value: "--token=sk-live-abcdefghijkl" }],
          },
        },
      }),
    ).toThrow(/resembles a credential/);
  });

  it("rejects arbitrary backend extensions in frozen profile v1", () => {
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

  it("rejects credential-bearing metadata keys", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        metadata: { nested: { database_url: "plaintext" } },
      }),
    ).toThrow(/credential-bearing keys/);
  });

  it("rejects lone surrogates even through generic profile sub-schemas", () => {
    expect(() =>
      agentCandidateProfileSchema.parse({
        prompt: { systemPrompt: "\ud800" },
      }),
    ).toThrow(/RFC 8785/);
  });
});
