import { describe, expect, it } from "vitest";
import {
  REASONING_EFFORTS,
  type AgentProfile,
  type AgentProfileMcpServer,
} from "./agent-profile.js";
import { harnessTypeSchema } from "./harness.js";
import { validateAgentProfileSecurity } from "./profile-security.js";
import { removeModelInputSchemaArtifacts } from "./profile-schema-json.js";
import {
  agentProfileDiffSchema,
  agentProfileJsonSchema,
  agentProfileSchema,
  capabilitySchema,
  parseAgentProfileModelInput,
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

  it("keeps every MCP branch and custom refinement aligned across contracts", () => {
    const corpus: Array<[string, unknown, boolean]> = [
      [
        "local",
        {
          mcp: {
            local: {
              command: "mcp",
              args: [{ kind: "public", value: "serve" }],
              cwd: "workspace",
              env: { MODE: { kind: "public", value: "read-only" } },
            },
          },
        },
        true,
      ],
      [
        "remote",
        {
          mcp: {
            remote: {
              transport: "http",
              url: "https://mcp.example.com/path",
              headers: {
                Authorization: {
                  kind: "secret-ref",
                  key: "REMOTE_AUTH",
                  format: "bearer",
                },
              },
            },
          },
        },
        true,
      ],
      ["disabled", { mcp: { disabled: { enabled: false } } }, true],
      [
        "remote command",
        { mcp: { invalid: { url: "https://mcp.example.com", command: "mcp" } } },
        false,
      ],
      [
        "remote args",
        {
          mcp: {
            invalid: {
              url: "https://mcp.example.com",
              args: [{ kind: "public", value: "serve" }],
            },
          },
        },
        false,
      ],
      [
        "disabled URL",
        {
          mcp: {
            invalid: { enabled: false, url: "https://mcp.example.com" },
          },
        },
        false,
      ],
      [
        "ftp URL",
        { mcp: { invalid: { url: "ftp://mcp.example.com" } } },
        false,
      ],
      ["local shell command", { mcp: { invalid: { command: "bash" } } }, false],
      [
        "uppercase local shell command",
        { mcp: { invalid: { command: "BASH" } } },
        false,
      ],
      [
        "public Authorization Bearer",
        {
          mcp: {
            invalid: {
              command: "mcp",
              env: { AUTHORIZATION: { kind: "public", value: "Bearer token" } },
            },
          },
        },
        false,
      ],
      [
        "uppercase secret-capable key with public value",
        {
          mcp: {
            invalid: {
              command: "mcp",
              env: { TOKEN: { kind: "public", value: "read-only" } },
            },
          },
        },
        false,
      ],
      [
        "uppercase credential query key",
        {
          mcp: {
            invalid: {
              url: "https://mcp.example.com?API_KEY=value",
            },
          },
        },
        false,
      ],
      [
        "invalid header key",
        {
          mcp: {
            invalid: {
              url: "https://mcp.example.com",
              headers: {
                "bad header": { kind: "secret-ref", key: "REMOTE_AUTH" },
              },
            },
          },
        },
        false,
      ],
    ];

    for (const [label, input, expected] of corpus) {
      const parsed = (() => {
        try {
          parseAgentProfileModelInput(input);
          return true;
        } catch {
          return false;
        }
      })();
      expect(parsed, `${label}: canonical model parser`).toBe(expected);
      expect(
        jsonSchemaAccepts(agentProfileJsonSchema, input),
        `${label}: generated JSON Schema`,
      ).toBe(expected);
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
      propertyNames: {
        type: "string",
        pattern: "^(?!__proto__$|constructor$|prototype$)[\\s\\S]*$",
      },
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
    expect(serialized).toContain(
      '"pattern":"^(?!__proto__$|constructor$|prototype$)',
    );
    expect(serialized).toContain("[\\\\s\\\\S]*$");
    expect(serialized).not.toContain('"$schema"');
  });

  it("fails closed for prototype-sensitive model record keys", () => {
    const tools = propertiesOf(agentProfileJsonSchema).tools as Record<
      string,
      unknown
    >;
    const propertyNames = tools.propertyNames as Record<string, unknown>;
    const keyPattern = new RegExp(String(propertyNames.pattern));

    expect(keyPattern.test("normal")).toBe(true);
    expect(keyPattern.test("__proto__")).toBe(false);
    expect(keyPattern.test("constructor")).toBe(false);
    expect(keyPattern.test("prototype")).toBe(false);

    const hostile = JSON.parse(
      '{"tools":{"__proto__":true,"normal":true}}',
    );
    const canonical = agentProfileSchema.parse(hostile);
    expect(Object.keys(canonical.tools ?? {})).toEqual(["__proto__", "normal"]);
    expect(
      Object.prototype.hasOwnProperty.call(canonical.tools, "__proto__"),
    ).toBe(true);

    expect(jsonSchemaAccepts(agentProfileJsonSchema, hostile)).toBe(false);
    expect(() => parseAgentProfileModelInput(hostile)).toThrow(
      /prototype-sensitive key/,
    );
  });

  it("rejects prototype-sensitive keys in nested open records before conversion", () => {
    const nestedInputs: Array<[string, unknown]> = [
      [
        "permissions.shell.__proto__",
        JSON.parse('{"permissions":{"shell":{"__proto__":"deny"}}}'),
      ],
      [
        "model.metadata.constructor",
        JSON.parse('{"model":{"metadata":{"constructor":true}}}'),
      ],
      [
        "mcp.local.metadata.prototype",
        JSON.parse(
          '{"mcp":{"local":{"command":"mcp","metadata":{"prototype":true}}}}',
        ),
      ],
      [
        "subagents.reviewer.tools.__proto__",
        JSON.parse(
          '{"subagents":{"reviewer":{"tools":{"__proto__":true}}}}',
        ),
      ],
      [
        "extensions.provider.constructor",
        JSON.parse('{"extensions":{"provider":{"constructor":true}}}'),
      ],
    ];

    for (const [path, input] of nestedInputs) {
      expect(() => parseAgentProfileModelInput(input), path).toThrow(path);
    }
  });

  it("admits ordinary model record keys through the canonical schema", () => {
    const input = JSON.parse(
      '{"tools":{"read_file":true,"write-file":false},"metadata":{"owner":{"team":"sdk"}}}',
    );

    const admitted = parseAgentProfileModelInput(input);

    expect(Object.keys(admitted.tools ?? {})).toEqual([
      "read_file",
      "write-file",
    ]);
    expect(admitted.metadata).toEqual({ owner: { team: "sdk" } });
  });

  it("rejects model input at the shared bounded JSON depth", () => {
    let nested: unknown = true;
    for (let depth = 0; depth <= 512; depth += 1) {
      nested = { nested };
    }

    expect(() => parseAgentProfileModelInput({ metadata: { nested } })).toThrow(
      /maximum JSON depth of 512/,
    );
  });

  it("removes encoded record artifacts from every supported emitter shape", () => {
    const encoded = "^u(?:[0-9a-f]{4})*$";
    const cleaned = removeModelInputSchemaArtifacts({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      propertyNames: { type: "string", pattern: encoded },
      patternProperties: {
        [encoded]: { type: "boolean" },
        "^safe$": { type: "boolean", pattern: encoded },
      },
      additionalProperties: { type: "string", pattern: encoded },
      nested: [{ $schema: "ignored", pattern: encoded }],
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toContain(encoded);
    expect(cleaned).not.toHaveProperty("$schema");
    expect(cleaned).toMatchObject({
      type: "object",
      patternProperties: { "^safe$": { type: "boolean" } },
      additionalProperties: { type: "boolean" },
      nested: [{}],
      propertyNames: {
        type: "string",
        pattern: "^(?!__proto__$|constructor$|prototype$)[\\s\\S]*$",
      },
    });

    for (const additionalProperties of [undefined, false]) {
      const rewritten = removeModelInputSchemaArtifacts({
        type: "object",
        patternProperties: {
          [encoded]: { type: "boolean" },
        },
        ...(additionalProperties === undefined ? {} : { additionalProperties }),
      }) as Record<string, unknown>;

      expect(rewritten).toMatchObject({
        additionalProperties: { type: "boolean" },
        propertyNames: {
          type: "string",
          pattern: "^(?!__proto__$|constructor$|prototype$)[\\s\\S]*$",
        },
      });
    }
  });

  it("keeps well-formed line-terminator keys aligned across both contracts", () => {
    const tools = propertiesOf(agentProfileJsonSchema).tools as Record<
      string,
      unknown
    >;
    const propertyNames = tools.propertyNames as Record<string, unknown>;
    const keyPattern = new RegExp(String(propertyNames.pattern));
    const keys = ["line\nbreak", "line\rbreak", "line\u2028break", "line\u2029break"];

    for (const key of keys) {
      const input = JSON.parse(JSON.stringify({ tools: { [key]: true } }));
      expect(keyPattern.test(key), JSON.stringify(key)).toBe(true);
      expect(parseAgentProfileModelInput(input).tools).toEqual({ [key]: true });
      expect(jsonSchemaAccepts(agentProfileJsonSchema, input), JSON.stringify(key)).toBe(
        true,
      );
    }
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

    expect(jsonSchemaAccepts(agentProfileJsonSchema, profile)).toBe(true);
    expect(parseAgentProfileModelInput(profile)).toEqual(profile);
  });
});

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.properties as Record<string, unknown>;
}

function jsonSchemaAccepts(schema: unknown, value: unknown): boolean {
  if (schema === true || schema === undefined) return true;
  if (schema === false || !schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (record.not !== undefined && jsonSchemaAccepts(record.not, value)) {
    return false;
  }
  if (
    Array.isArray(record.allOf) &&
    !record.allOf.every((entry) => jsonSchemaAccepts(entry, value))
  ) {
    return false;
  }
  if (
    Array.isArray(record.anyOf) &&
    !record.anyOf.some((entry) => jsonSchemaAccepts(entry, value))
  ) {
    return false;
  }
  if (Array.isArray(record.oneOf)) {
    const matches = record.oneOf.filter((entry) =>
      jsonSchemaAccepts(entry, value),
    ).length;
    if (matches !== 1) return false;
  }
  if (record.const !== undefined && !Object.is(record.const, value)) {
    return false;
  }
  if (
    Array.isArray(record.enum) &&
    !record.enum.some((entry) => Object.is(entry, value))
  ) {
    return false;
  }

  if (record.type !== undefined && !matchesJsonType(record.type, value)) {
    return false;
  }
  if (typeof value === "string") {
    if (
      typeof record.minLength === "number" &&
      value.length < record.minLength
    ) {
      return false;
    }
    if (
      typeof record.maxLength === "number" &&
      value.length > record.maxLength
    ) {
      return false;
    }
    if (typeof record.pattern === "string" && !new RegExp(record.pattern).test(value)) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (
      typeof record.minItems === "number" &&
      value.length < record.minItems
    ) {
      return false;
    }
    if (
      typeof record.maxItems === "number" &&
      value.length > record.maxItems
    ) {
      return false;
    }
    if (
      record.items !== undefined &&
      !value.every((entry) => jsonSchemaAccepts(record.items, entry))
    ) {
      return false;
    }
    return true;
  }
  if (value === null || typeof value !== "object") return true;

  const objectValue = value as Record<string, unknown>;
  const properties = isRecordSchema(record.properties)
    ? record.properties
    : {};
  const required = Array.isArray(record.required) ? record.required : [];
  for (const key of required) {
    if (typeof key !== "string" || !Object.hasOwn(objectValue, key)) {
      return false;
    }
  }
  const propertyNames = record.propertyNames;
  const patternProperties = isRecordSchema(record.patternProperties)
    ? record.patternProperties
    : {};
  const additional = record.additionalProperties;
  for (const [key, entry] of Object.entries(objectValue)) {
    if (
      propertyNames !== undefined &&
      !jsonSchemaAccepts(propertyNames, key)
    ) {
      return false;
    }
    let matched = false;
    if (Object.hasOwn(properties, key)) {
      matched = true;
      if (!jsonSchemaAccepts(properties[key], entry)) return false;
    }
    for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
      if (new RegExp(pattern).test(key)) {
        matched = true;
        if (!jsonSchemaAccepts(patternSchema, entry)) return false;
      }
    }
    if (!matched && additional === false) return false;
    if (!matched && additional !== undefined && additional !== true) {
      if (!jsonSchemaAccepts(additional, entry)) return false;
    }
  }
  return true;
}

function matchesJsonType(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) return type.some((entry) => matchesJsonType(entry, value));
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function isRecordSchema(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
