import { describe, expect, it } from "vitest";
import type { AgentProfileMcpServer } from "./agent-profile.js";
import { validateAgentProfileSecurity } from "./profile-security.js";
import {
  agentProfileDiffSchema,
  agentProfileSchema,
  capabilitySchema,
} from "./profile-schema.js";

// @ts-expect-error A server cannot select local and remote execution together.
const ambiguousMcpServer: AgentProfileMcpServer = {
  command: "mcp",
  url: "https://mcp.example.com",
};
void ambiguousMcpServer;

describe("agentProfileSchema", () => {
  it("rejects unknown behavior at every defined object boundary", () => {
    const invalidProfiles: Array<[string, unknown]> = [
      ["root", { unknown: true }],
      ["prompt", { prompt: { systemPrompt: "review", unknown: true } }],
      ["model", { model: { default: "openai/gpt-5", unknown: true } }],
      [
        "resource collection",
        { resources: { failOnError: true, unknown: true } },
      ],
      [
        "resource reference",
        {
          resources: {
            skills: [
              {
                kind: "inline",
                name: "review",
                content: "Review carefully",
                unknown: true,
              },
            ],
          },
        },
      ],
      [
        "file mount",
        {
          resources: {
            files: [
              {
                path: "AGENTS.md",
                resource: {
                  kind: "inline",
                  name: "instructions",
                  content: "Review carefully",
                },
                unknown: true,
              },
            ],
          },
        },
      ],
      [
        "subagent",
        {
          subagents: {
            reviewer: {
              prompt: "Review carefully",
              permission: { bash: "deny" },
            },
          },
        },
      ],
      [
        "hook",
        { hooks: { beforeRun: [{ command: "prepare", unknown: true }] } },
      ],
      ["mode", { modes: { review: { prompt: "Review", unknown: true } } }],
      ["confidential", { confidential: { tee: "tdx", unknown: true } }],
      ["MCP", { mcp: { local: { command: "mcp", unknown: true } } }],
      [
        "connection",
        {
          connections: [
            {
              connectionId: "github",
              capabilities: ["repo.read"],
              unknown: true,
            },
          ],
        },
      ],
    ];

    for (const [label, profile] of invalidProfiles) {
      expect(agentProfileSchema.safeParse(profile).success, label).toBe(false);
    }
  });

  it("keeps explicitly open metadata and extension values", () => {
    const profile = {
      model: { metadata: { providerSetting: { nested: true } } },
      metadata: { customer: { segment: "design" } },
      extensions: { opencode: { futureSetting: { enabled: true } } },
    };

    expect(agentProfileSchema.parse(profile)).toEqual(profile);
  });

  it("accepts unambiguous local, remote, and disabled MCP servers", () => {
    const profile = {
      mcp: {
        local: { command: "mcp", args: ["serve"], env: { TOKEN: "value" } },
        remote: {
          transport: "http" as const,
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer value" },
        },
        disabled: { enabled: false },
        localWithUndefinedRemote: { command: "mcp", url: undefined },
        remoteWithUndefinedLocal: {
          url: "https://mcp.example.com",
          command: undefined,
        },
      },
    };

    expect(agentProfileSchema.parse(profile)).toEqual(profile);
    expect(
      validateAgentProfileSecurity(
        { mcp: { disabled: { enabled: false } } },
        {
          allowLocalMcp: false,
          allowHooks: false,
          allowedMcpHosts: [],
        },
      ),
    ).toMatchObject({ ok: true, issues: [] });
  });

  it("rejects ambiguous or incomplete MCP servers", () => {
    const invalidServers = [
      { command: "mcp", url: "https://mcp.example.com" },
      { transport: "stdio", url: "https://mcp.example.com" },
      { transport: "http", command: "mcp" },
      { args: ["serve"] },
      { headers: { Authorization: "Bearer value" } },
      { enabled: true },
      { enabled: false, transport: "stdio" },
      { enabled: false, command: "mcp" },
      { enabled: false, url: "https://mcp.example.com" },
      { enabled: false, args: [] },
      { enabled: false, cwd: "" },
      { enabled: false, headers: {} },
      { command: " " },
      { url: " " },
      { url: "not-a-url" },
      { url: "ftp://mcp.example.com" },
    ];

    for (const server of invalidServers) {
      expect(
        agentProfileSchema.safeParse({ mcp: { invalid: server } }).success,
      ).toBe(false);
    }
  });
});

describe("profile container schemas", () => {
  it("rejects unknown diff and capability fields", () => {
    expect(
      agentProfileDiffSchema.safeParse({
        kind: "agent-profile-diff",
        source: { kind: "human", unknown: true },
      }).success,
    ).toBe(false);
    expect(
      agentProfileDiffSchema.safeParse({
        kind: "agent-profile-diff",
        remove: { prompt: { systemPrompt: true, unknown: true } },
      }).success,
    ).toBe(false);
    expect(
      capabilitySchema.safeParse({
        id: "review",
        definition: {},
        unknown: true,
      }).success,
    ).toBe(false);
  });
});
