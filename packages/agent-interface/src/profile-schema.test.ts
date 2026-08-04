import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  REASONING_EFFORTS,
  type AgentProfile,
  type AgentProfileMcpServer,
} from "./agent-profile.js";
import { harnessTypeSchema } from "./harness.js";
import { validateAgentProfileSecurity } from "./profile-security.js";
import {
  agentProfileDiffSchema,
  agentProfileJsonSchema,
  agentProfileSchema,
  capabilitySchema,
  reasoningEffortSchema,
} from "./profile-schema.js";

// @ts-expect-error A server cannot select local and remote execution together.
const ambiguousMcpServer: AgentProfileMcpServer = {
  command: "mcp",
  url: "https://mcp.example.com",
};
void ambiguousMcpServer;

describe("agentProfileSchema", () => {
  it("derives reasoning validation from the canonical ordered values", () => {
    expect(Object.isFrozen(REASONING_EFFORTS)).toBe(true);
    expect(reasoningEffortSchema.options).toEqual(REASONING_EFFORTS);
  });

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

  it("preserves and validates hostile own record keys without mutating prototypes", () => {
    const profile = JSON.parse(`{
      "tools": {
        "__proto__": false,
        "constructor": true,
        "toString": false,
        "a/b~c": true
      },
      "permissions": {
        "shell": {
          "__proto__": "deny",
          "constructor": "ask"
        }
      },
      "model": {
        "metadata": {
          "__proto__": { "nested": true }
        }
      },
      "mcp": {
        "local": {
          "command": "mcp",
          "metadata": { "__proto__": "literal-value" }
        }
      },
      "extensions": {
        "__proto__": {
          "__proto__": 0,
          "constructor": false
        }
      }
    }`);

    const parsed = agentProfileSchema.parse(profile);

    expect(Object.keys(parsed.tools ?? {})).toEqual([
      "__proto__",
      "constructor",
      "toString",
      "a/b~c",
    ]);
    expect(Object.prototype.hasOwnProperty.call(parsed.tools, "__proto__")).toBe(
      true,
    );
    expect(Object.getPrototypeOf(parsed.tools)).toBe(Object.prototype);
    expect(parsed.tools?.__proto__).toBe(false);
    expect(Object.getPrototypeOf(parsed.permissions?.shell)).toBe(
      Object.prototype,
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        parsed.permissions?.shell,
        "__proto__",
      ),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(parsed.model?.metadata, "__proto__"),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(
        parsed.mcp?.local?.metadata,
        "__proto__",
      ),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(parsed.extensions, "__proto__"),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(
        parsed.extensions?.__proto__,
        "__proto__",
      ),
    ).toBe(true);

    const invalid = JSON.parse('{"tools":{"__proto__":"not-a-boolean"}}');
    expect(agentProfileSchema.safeParse(invalid).success).toBe(false);

    const malformedKey = String.fromCharCode(0xd800);
    const metadata: Record<string, unknown> = {};
    Object.defineProperty(metadata, malformedKey, {
      value: 0,
      enumerable: true,
    });
    expect(agentProfileSchema.safeParse({ metadata }).success).toBe(false);

    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, malformedKey, {
      value: false,
      enumerable: true,
    });
    expect(
      agentProfileSchema.safeParse({ metadata: { nested } }).success,
    ).toBe(false);
  });

  it("accepts unambiguous local, remote, and disabled MCP servers", () => {
    const profile = {
      mcp: {
        local: {
          command: "mcp",
          args: [{ kind: "public" as const, value: "serve" }],
          env: {
            MODE: { kind: "public" as const, value: "read-only" },
            TOKEN: {
              kind: "secret-ref" as const,
              key: "LOCAL_MCP_TOKEN",
            },
          },
        },
        remote: {
          transport: "http" as const,
          url: "https://mcp.example.com",
          headers: {
            Authorization: {
              kind: "secret-ref" as const,
              key: "REMOTE_MCP_AUTH",
              format: "bearer" as const,
            },
          },
        },
        disabled: { enabled: false },
        localWithUndefinedRemote: { command: "mcp", url: undefined },
        remoteWithUndefinedLocal: {
          url: "https://mcp.example.com",
          command: undefined,
        },
      },
      hooks: {
        beforeRun: [
          {
            command: "prepare",
            env: {
              PREPARE_TOKEN: {
                kind: "secret-ref" as const,
                key: "HOOK_PREPARE_TOKEN",
              },
            },
          },
        ],
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
      { url: "https://user:password@mcp.example.com" },
      { url: "https://mcp.example.com?api_key=value" },
      { enabled: true },
      { enabled: false, transport: "stdio" },
      { enabled: false, command: "mcp" },
      { enabled: false, url: "https://mcp.example.com" },
      { enabled: false, args: [] },
      { enabled: false, cwd: "" },
      { enabled: false, headers: {} },
      { command: " " },
      { command: "mcp --token=value" },
      { command: "bash" },
      { command: "mcp", cwd: "../outside" },
      {
        command: "mcp",
        env: { TOKEN: { kind: "public", value: "not-secret" } },
      },
      {
        command: "mcp",
        args: [{ kind: "public", value: "Bearer raw-credential" }],
      },
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

  it("requires tagged hook config and secret references for sensitive names", () => {
    const invalidProfiles = [
      { hooks: { beforeRun: [{ command: "prepare", env: { MODE: "raw" } }] } },
      {
        hooks: {
          beforeRun: [
            {
              command: "prepare",
              env: { PREPARE_TOKEN: { kind: "public", value: "benign" } },
            },
          ],
        },
      },
      {
        hooks: {
          beforeRun: [
            {
              command: "prepare",
              env: {
                TOKEN: {
                  kind: "secret-ref",
                  key: "Bearer actual-credential",
                },
              },
            },
          ],
        },
      },
      {
        hooks: {
          beforeRun: [
            {
              command: "prepare",
              env: { TOKEN: { kind: "secret-ref", key: "   " } },
            },
          ],
        },
      },
      {
        hooks: {
          beforeRun: [
            {
              command: "prepare",
              env: {
                MODE: { kind: "public", value: "Bearer raw-credential" },
              },
            },
          ],
        },
      },
    ];

    for (const profile of invalidProfiles) {
      expect(agentProfileSchema.safeParse(profile).success).toBe(false);
    }
  });
});

describe("agentProfileJsonSchema", () => {
  it("describes the complete authored profile without encoded record-key constraints", () => {
    const properties = agentProfileJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties.prompt).toMatchObject({
      type: "object",
      properties: {
        systemPrompt: { type: "string" },
        instructions: { type: "array", items: { type: "string" } },
      },
    });
    expect(properties.model).toMatchObject({
      type: "object",
      properties: {
        default: { type: "string" },
        provider: { type: "string" },
      },
    });
    expect(properties.harness).toEqual({
      type: "string",
      enum: harnessTypeSchema.options,
    });
    expect(properties.extensions).toMatchObject({
      type: "object",
      additionalProperties: {
        anyOf: [{ type: "object", additionalProperties: {} }, {}],
      },
    });
    expect(properties.tools).toMatchObject({
      type: "object",
      additionalProperties: { type: "boolean" },
    });
    expect(properties.permissions).toMatchObject({
      type: "object",
      additionalProperties: {
        anyOf: [
          { type: "string", enum: ["allow", "deny", "ask"] },
          {
            type: "object",
            additionalProperties: {
              type: "string",
              enum: ["allow", "deny", "ask"],
            },
          },
        ],
      },
    });

    const serialized = JSON.stringify(agentProfileJsonSchema);
    expect(serialized).not.toContain("^u(?:[0-9a-f]{4})*$");
    expect(serialized).not.toContain('"propertyNames"');
    expect(serialized).not.toContain('"$schema"');
  });

  it("admits one ordinary complete profile through both published contracts", () => {
    const profile: AgentProfile = {
      name: "research-worker",
      description: "Investigate one question and preserve evidence.",
      version: "1.0.0",
      tags: ["research", "technical"],
      prompt: {
        systemPrompt: "Investigate the supplied task.",
        instructions: ["Record evidence.", "State uncertainty."],
      },
      model: {
        default: "router/frontier",
        small: "router/fast",
        provider: "router",
        reasoningEffort: "high",
        metadata: { routing: { latencyClass: "interactive" } },
      },
      harness: "pi",
      permissions: {
        shell: "allow",
        network: { read: "allow", write: "ask" },
      },
      tools: { read_file: true, write_file: false },
      mcp: {
        knowledge: {
          transport: "http",
          url: "https://mcp.example.com",
          headers: {
            Authorization: {
              kind: "secret-ref",
              key: "MCP_AUTH",
              format: "bearer",
            },
          },
        },
      },
      connections: [
        {
          connectionId: "github-primary",
          capabilities: ["repo.read"],
          alias: "source",
        },
      ],
      subagents: {
        reviewer: {
          description: "Review evidence.",
          prompt: "Find unsupported claims.",
          model: "router/frontier",
          tools: { read_file: true },
          permissions: { shell: "deny" },
          maxSteps: 4,
          metadata: { focus: { citations: true } },
        },
      },
      resources: {
        files: [
          {
            path: "AGENTS.md",
            resource: {
              kind: "inline",
              name: "instructions",
              content: "Preserve primary evidence.",
            },
          },
        ],
        skills: [
          {
            kind: "inline",
            name: "source-review",
            content: "Check every claim against its source.",
          },
        ],
        instructions: "Follow the supplied research protocol.",
        failOnError: true,
      },
      hooks: {
        beforeRun: [
          {
            command: "prepare",
            timeoutMs: 1_000,
            blocking: true,
            matcher: "research",
            env: {
              MODE: { kind: "public", value: "read-only" },
            },
          },
        ],
      },
      modes: {
        review: {
          description: "Audit a draft.",
          model: "router/frontier",
          prompt: "Check the draft.",
          tools: { read_file: true },
          permissions: { shell: "deny" },
          metadata: { severity: "strict" },
        },
      },
      confidential: {
        tee: "tdx",
        attestationNonce: "public-nonce",
        sealed: true,
        attestationRefresh: true,
      },
      metadata: { owner: { team: "discovery" } },
      extensions: {
        provider: { session: { durable: true } },
      },
    };

    const modelInputSchema = z.fromJSONSchema(agentProfileJsonSchema);

    expect(modelInputSchema.safeParse(profile).success).toBe(true);
    expect(agentProfileSchema.safeParse(profile).success).toBe(true);
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
