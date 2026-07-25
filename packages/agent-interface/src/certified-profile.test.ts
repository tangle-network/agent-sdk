import { describe, expect, it } from "vitest";
import {
  certifiedCapabilitySchema,
  certifiedProfileSchema,
  parseCertifiedProfile,
} from "./certified-profile.js";

const provenance = {
  contentHash: "sha256:abc",
  version: 3,
  lift: "+3.1pp",
  promotedAt: "2026-07-25T20:00:00.000Z",
};

const profile = {
  target: "support-agent",
  generatedAt: "2026-07-25T20:01:00.000Z",
  capabilities: [
    {
      id: "prompt",
      iface: {
        surface: "context",
        kind: "prompt",
        name: "system prompt",
      },
      binding: {
        kind: "inline",
        content: "Verify the invoice before issuing a refund.",
      },
      provenance: { ...provenance, sourcePath: null },
    },
    {
      id: "refund-tool",
      iface: {
        surface: "tool",
        name: "issue_refund",
        parameters: {
          type: "object",
          properties: { invoiceId: { type: "string" } },
        },
      },
      binding: {
        kind: "http",
        url: "https://tools.example.com/refund",
        auth: { mode: "tangle-key" },
      },
      provenance: { ...provenance, sourcePath: "tools/refund.json" },
    },
  ],
  profileDiffs: [],
};

describe("certifiedProfileSchema", () => {
  it("parses the current capability-only profile", () => {
    expect(parseCertifiedProfile(profile)).toEqual(profile);
  });

  it("rejects the removed promptSurface and artifacts representation", () => {
    expect(() =>
      parseCertifiedProfile({
        ...profile,
        promptSurface: null,
        artifacts: {},
      }),
    ).toThrow();
  });

  it("rejects the removed composed-profile representation", () => {
    expect(() =>
      parseCertifiedProfile({
        ...profile,
        agentProfileDiffs: [],
        agentProfile: null,
      }),
    ).toThrow();
  });

  it("rejects unsupported interface and binding combinations", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[0],
        binding: {
          kind: "http",
          url: "https://tools.example.com/context",
        },
      }),
    ).toThrow(/context capabilities do not support http bindings/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[1],
        binding: { kind: "inline", content: "static response" },
      }),
    ).toThrow(/tool capabilities do not support inline bindings/);
  });

  it("rejects blank delivered context", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[0],
        binding: { kind: "inline", content: "   " },
      }),
    ).toThrow(/context capability content cannot be blank/);
  });

  it("rejects duplicate capability ids", () => {
    expect(() =>
      certifiedProfileSchema.parse({
        ...profile,
        capabilities: [
          profile.capabilities[0],
          profile.capabilities[0],
        ],
      }),
    ).toThrow(/duplicate capability id/);
  });

  it("rejects callable and mount collisions", () => {
    const duplicateTool = {
      ...profile.capabilities[1],
      id: "refund-tool-copy",
    };
    expect(() =>
      certifiedProfileSchema.parse({
        ...profile,
        capabilities: [...profile.capabilities, duplicateTool],
      }),
    ).toThrow(/duplicate tool name/);

    const file = {
      id: "refund-skill",
      iface: {
        surface: "context" as const,
        kind: "skill" as const,
        name: "refund skill",
      },
      binding: {
        kind: "file" as const,
        path: "skills/refund.md",
        content: "Check the invoice.",
      },
      provenance: {
        ...provenance,
        sourcePath: "skills/refund.md",
      },
    };
    expect(() =>
      certifiedProfileSchema.parse({
        ...profile,
        capabilities: [file, { ...file, id: "refund-skill-copy" }],
      }),
    ).toThrow(/duplicate file path/);
  });

  it("accepts a certified profile diff without a duplicate composed profile", () => {
    const profileDiff = {
      diff: {
        kind: "agent-profile-diff" as const,
        set: { prompt: { instructions: ["Ask for the invoice id."] } },
      },
      provenance,
    };

    expect(
      certifiedProfileSchema.parse({
        ...profile,
        profileDiffs: [profileDiff],
      }).profileDiffs,
    ).toEqual([profileDiff]);
  });

  it("supports file and remote MCP bindings", () => {
    expect(
      certifiedCapabilitySchema.parse({
        id: "refund-skill",
        iface: {
          surface: "context",
          kind: "skill",
          name: "refund policy",
        },
        binding: {
          kind: "file",
          path: "skills/refund.md",
          content: "Check the invoice.",
          executable: false,
        },
        provenance: { ...provenance, version: null, lift: null, sourcePath: null },
      }).binding.kind,
    ).toBe("file");

    expect(
      certifiedCapabilitySchema.parse({
        id: "crm",
        iface: {
          surface: "mcp",
          serverName: "crm",
          toolset: ["lookup_customer"],
        },
        binding: {
          kind: "mcp-remote",
          url: "https://mcp.example.com",
          transport: "http",
          auth: {
            mode: "hub-connection",
            providerId: "salesforce",
            scopes: ["customer:read"],
          },
        },
        provenance: { ...provenance, sourcePath: "mcp/crm.json" },
      }).binding.kind,
    ).toBe("mcp-remote");
  });

  it("requires HTTPS before transmitting credentials", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[1],
        binding: {
          kind: "http",
          url: "http://tools.example.com/refund",
          auth: { mode: "tangle-key" },
        },
      }),
    ).toThrow(/authenticated remote bindings require HTTPS/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        id: "crm",
        iface: { surface: "mcp", serverName: "crm" },
        binding: {
          kind: "mcp-remote",
          url: "http://mcp.example.com",
          transport: "sse",
          auth: { mode: "secret-ref", key: "CRM_TOKEN" },
        },
        provenance: { ...provenance, sourcePath: null },
      }),
    ).toThrow(/authenticated remote bindings require HTTPS/);
  });

  it("allows HTTP only when no credential is transmitted", () => {
    expect(
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[1],
        binding: {
          kind: "http",
          url: "http://localhost:8787/refund",
          auth: { mode: "none" },
        },
      }).binding.kind,
    ).toBe("http");
  });

  it("rejects invalid provenance and blank optional labels", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[0],
        provenance: { ...provenance, version: 0, sourcePath: null },
      }),
    ).toThrow();

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[0],
        provenance: { ...provenance, sourcePath: "   " },
      }),
    ).toThrow(/value cannot be blank/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[1],
        iface: {
          ...profile.capabilities[1].iface,
          description: " ",
        },
      }),
    ).toThrow(/value cannot be blank/);
  });

  it("rejects unsafe paths, commands, and callable names", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        id: "escape",
        iface: {
          surface: "context",
          kind: "skill",
          name: "escape",
        },
        binding: {
          kind: "file",
          path: "../escape.md",
          content: "unsafe",
        },
        provenance: { ...provenance, sourcePath: null },
      }),
    ).toThrow(/canonical relative path/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        id: "shell",
        iface: { surface: "mcp", serverName: "shell" },
        binding: {
          kind: "mcp-stdio",
          command: "sh",
          args: ["-c", "echo unsafe"],
        },
        provenance: { ...provenance, sourcePath: null },
      }),
    ).toThrow(/non-shell executable/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[1],
        iface: {
          ...profile.capabilities[1].iface,
          name: "not a portable tool name",
        },
      }),
    ).toThrow(/portable callable name/);
  });

  it("rejects non-HTTP remote URLs", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[1],
        binding: {
          kind: "http",
          url: "ftp://tools.example.com/refund",
        },
      }),
    ).toThrow(/absolute HTTP/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile.capabilities[1],
        binding: {
          kind: "http",
          url: "not-a-url",
          auth: { mode: "tangle-key" },
        },
      }),
    ).toThrow(/absolute HTTP/);
  });
});
