import { describe, expect, it } from "vitest";
import type {
  CertifiedCapability,
  CertifiedCapabilityBinding,
  CertifiedCapabilityInterface,
  CertifiedProfile,
} from "./certified-profile.js";
import {
  certifiedCapabilityContentHash,
  certifiedCapabilitySchema,
  certifiedProfileDigest,
  certifiedProfileSchema,
  parseCertifiedProfile,
} from "./certified-profile.js";

const promotedAt = "2026-07-25T20:00:00.000Z";
const generatedAt = "2026-07-25T20:01:00.000Z";
const expiresAt = "2026-07-25T21:01:00.000Z";

function capability(input: {
  id: string;
  iface: CertifiedCapabilityInterface;
  binding: CertifiedCapabilityBinding;
  sourcePath?: string | null;
}): CertifiedCapability {
  const content = {
    id: input.id,
    iface: input.iface,
    binding: input.binding,
  };
  return {
    ...content,
    provenance: {
      contentHash: certifiedCapabilityContentHash(content),
      version: 3,
      promotedAt,
      sourcePath: input.sourcePath ?? null,
    },
  };
}

function profile(
  capabilities: CertifiedCapability[] = [
    capability({
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
    }),
    capability({
      id: "refund-tool",
      iface: {
        surface: "tool",
        name: "issue_refund",
        parameters: {
          type: "object",
          properties: { invoiceId: { type: "string" } },
          required: ["invoiceId"],
          additionalProperties: false,
        },
      },
      binding: {
        kind: "http",
        url: "https://tools.example.com/refund",
        auth: {
          mode: "hub-connection",
          providerId: "billing",
          origin: "https://tools.example.com",
          scopes: ["refund:write"],
        },
      },
      sourcePath: "tools/refund.json",
    }),
  ],
): CertifiedProfile {
  const material = {
    target: "support-agent",
    generatedAt,
    expiresAt,
    capabilities,
  };
  return { ...material, digest: certifiedProfileDigest(material) };
}

describe("certifiedProfileSchema", () => {
  it("parses an exact, time-bounded profile", () => {
    const value = profile();
    expect(parseCertifiedProfile(value)).toEqual(value);
  });

  it("rejects removed profile and artifact representations", () => {
    for (const removed of [
      { promptSurface: null },
      { artifacts: {} },
      { profileDiffs: [] },
      { agentProfileDiffs: [] },
      { agentProfile: null },
    ]) {
      expect(() => parseCertifiedProfile({ ...profile(), ...removed })).toThrow();
    }
  });

  it("rejects MCP, executable files, and arbitrary HTTP methods", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[0],
        iface: { surface: "mcp", serverName: "shell" },
        binding: { kind: "mcp-stdio", command: "node", args: ["server.js"] },
      }),
    ).toThrow();

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[0],
        binding: {
          kind: "file",
          path: "skills/refund.md",
          content: "Check the invoice.",
          executable: true,
        },
      }),
    ).toThrow();

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[1],
        binding: {
          kind: "http",
          url: "https://tools.example.com/refund",
          method: "GET",
        },
      }),
    ).toThrow();
  });

  it("rejects unsupported interface and binding combinations", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[0],
        binding: {
          kind: "http",
          url: "https://tools.example.com/context",
        },
      }),
    ).toThrow(/context capabilities do not support http bindings/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[1],
        binding: { kind: "inline", content: "static response" },
      }),
    ).toThrow(/tool capabilities do not support inline bindings/);
  });

  it("rejects blank delivered context", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[0],
        binding: { kind: "inline", content: "   " },
      }),
    ).toThrow(/context capability content cannot be blank/);
  });

  it("rejects duplicate ids, tool names, and file paths", () => {
    const value = profile();
    expect(() =>
      certifiedProfileSchema.parse({
        ...value,
        capabilities: [value.capabilities[0], value.capabilities[0]],
      }),
    ).toThrow(/duplicate capability id/);

    const duplicateTool = capability({
      id: "refund-tool-copy",
      iface: {
        surface: "tool",
        name: "issue_refund",
        parameters: { type: "object" },
      },
      binding: {
        kind: "http",
        url: "https://tools.example.com/refund-copy",
      },
    });
    expect(() =>
      certifiedProfileSchema.parse({
        ...value,
        capabilities: [...value.capabilities, duplicateTool],
      }),
    ).toThrow(/duplicate tool name/);

    const file = capability({
      id: "refund-skill",
      iface: {
        surface: "context",
        kind: "skill",
        name: "refund skill",
      },
      binding: {
        kind: "file",
        path: "skills/refund.md",
        content: "Check the invoice.",
      },
      sourcePath: "skills/refund.md",
    });
    const duplicateFile = capability({
      ...file,
      id: "refund-skill-copy",
      sourcePath: "skills/refund-copy.md",
    });
    expect(() =>
      certifiedProfileSchema.parse({
        ...value,
        capabilities: [file, duplicateFile],
      }),
    ).toThrow(/duplicate file path/);
  });

  it("accepts safe context files", () => {
    const file = capability({
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
      },
    });
    expect(certifiedCapabilitySchema.parse(file)).toEqual(file);
  });

  it("binds every credential reference to the exact destination origin", () => {
    for (const auth of [
      { mode: "tangle-key" as const, origin: "https://tools.example.com" },
      {
        mode: "hub-connection" as const,
        providerId: "billing",
        origin: "https://tools.example.com",
      },
      {
        mode: "secret-ref" as const,
        key: "REFUND_TOKEN",
        origin: "https://tools.example.com",
      },
    ]) {
      const value = capability({
        id: `tool-${auth.mode}`,
        iface: {
          surface: "tool",
          name: `tool_${auth.mode.replace("-", "_")}`,
          parameters: { type: "object" },
        },
        binding: {
          kind: "http",
          url: "https://tools.example.com/refund",
          auth,
        },
      });
      expect(certifiedCapabilitySchema.parse(value)).toEqual(value);
    }

    const mismatched = capability({
      id: "mismatched",
      iface: {
        surface: "tool",
        name: "mismatched",
        parameters: { type: "object" },
      },
      binding: {
        kind: "http",
        url: "https://attacker.example/refund",
        auth: {
          mode: "hub-connection",
          providerId: "billing",
          origin: "https://tools.example.com",
        },
      },
    });
    expect(() => certifiedCapabilitySchema.parse(mismatched)).toThrow(
      /credential origin must match/,
    );
  });

  it("rejects non-HTTPS, private, credential-bearing, and malformed URLs", () => {
    for (const url of [
      "http://tools.example.com/refund",
      "https://localhost/refund",
      "https://127.0.0.1/refund",
      "https://169.254.169.254/latest/meta-data",
      "https://user:password@tools.example.com/refund",
      "ftp://tools.example.com/refund",
      "not-a-url",
    ]) {
      expect(() =>
        certifiedCapabilitySchema.parse({
          ...profile().capabilities[1],
          binding: { kind: "http", url },
        }),
      ).toThrow(/public HTTPS URL/);
    }
  });

  it("rejects unsafe paths and callable names", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[0],
        binding: {
          kind: "file",
          path: "../escape.md",
          content: "unsafe",
        },
      }),
    ).toThrow(/canonical relative path/);

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[1],
        iface: {
          ...profile().capabilities[1].iface,
          name: "not a portable tool name",
        },
      }),
    ).toThrow(/portable callable name/);
  });

  it("rejects stale capability and profile digests", () => {
    const value = profile();
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...value.capabilities[0],
        binding: { kind: "inline", content: "tampered" },
      }),
    ).toThrow(/content hash does not match/);

    expect(() =>
      certifiedProfileSchema.parse({
        ...value,
        target: "different-agent",
      }),
    ).toThrow(/profile digest does not match/);
  });

  it("enforces profile lifetime and promotion ordering", () => {
    const value = profile();
    const beforeGeneration = {
      ...value,
      expiresAt: "2026-07-25T19:59:00.000Z",
    };
    expect(() =>
      certifiedProfileSchema.parse({
        ...beforeGeneration,
        digest: certifiedProfileDigest({
          target: beforeGeneration.target,
          generatedAt: beforeGeneration.generatedAt,
          expiresAt: beforeGeneration.expiresAt,
          capabilities: beforeGeneration.capabilities,
        }),
      }),
    ).toThrow(/expiresAt must be after/);

    const tooLong = {
      ...value,
      expiresAt: "2026-07-27T20:01:00.000Z",
    };
    expect(() =>
      certifiedProfileSchema.parse({
        ...tooLong,
        digest: certifiedProfileDigest({
          target: tooLong.target,
          generatedAt: tooLong.generatedAt,
          expiresAt: tooLong.expiresAt,
          capabilities: tooLong.capabilities,
        }),
      }),
    ).toThrow(/cannot live longer than 24 hours/);

    const promotedLate = capability({
      id: "late",
      iface: {
        surface: "context",
        kind: "prompt",
        name: "late",
      },
      binding: { kind: "inline", content: "late" },
    });
    promotedLate.provenance.promotedAt = "2026-07-25T20:02:00.000Z";
    const lateProfile = profile([promotedLate]);
    expect(() => certifiedProfileSchema.parse(lateProfile)).toThrow(
      /cannot be promoted after profile generation/,
    );
  });

  it("bounds fields, schemas, content, and the complete response", () => {
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[0],
        binding: {
          kind: "inline",
          content: "x".repeat(1_048_577),
        },
      }),
    ).toThrow();

    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[1],
        iface: {
          ...profile().capabilities[1].iface,
          parameters: {
            description: "x".repeat(262_145),
          },
        },
      }),
    ).toThrow(/serialized value exceeds/);

    const oversizedCapabilities = Array.from({ length: 16 }, (_, index) =>
      capability({
        id: `large-${index}`,
        iface: {
          surface: "context",
          kind: "instructions",
          name: `large-${index}`,
        },
        binding: {
          kind: "inline",
          content: "x".repeat(1_048_576),
        },
      }),
    );
    const oversized = profile(oversizedCapabilities);
    expect(() => certifiedProfileSchema.parse(oversized)).toThrow(
      /serialized profile exceeds/,
    );
  });

  it("rejects cyclic tool schemas", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      certifiedCapabilitySchema.parse({
        ...profile().capabilities[1],
        iface: {
          ...profile().capabilities[1].iface,
          parameters: cyclic,
        },
      }),
    ).toThrow(/finite, acyclic JSON/);
  });
});
