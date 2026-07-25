import { describe, expect, it } from "vitest";
import type {
  CertifiedContext,
  CertifiedContextDelivery,
  CertifiedContextEntry,
  CertifiedContextKind,
} from "./certified-context.js";
import {
  certifiedContextContentHash,
  certifiedContextEntryContentHash,
  certifiedContextEntrySchema,
  certifiedContextSchema,
  parseCertifiedContext,
} from "./certified-context.js";

const promotedAt = "2026-07-25T20:00:00.000Z";
const generatedAt = "2026-07-25T20:01:00.000Z";
const expiresAt = "2026-07-25T20:11:00.000Z";

function entry(input: {
  id: string;
  kind: CertifiedContextKind;
  name: string;
  delivery: CertifiedContextDelivery;
}): CertifiedContextEntry {
  const material = {
    id: input.id,
    kind: input.kind,
    name: input.name,
    delivery: input.delivery,
  };
  return {
    ...material,
    provenance: {
      contentHash: certifiedContextEntryContentHash(material),
      version: 3,
      promotedAt,
    },
  };
}

function context(
  entries: readonly CertifiedContextEntry[] = [
    entry({
      id: "prompt",
      kind: "prompt",
      name: "system prompt",
      delivery: {
        kind: "inline",
        content: "Verify the invoice before issuing a refund.",
      },
    }),
    entry({
      id: "refund-skill",
      kind: "skill",
      name: "refund skill",
      delivery: {
        kind: "file",
        path: "skills/refund/SKILL.md",
        content: "Check the invoice.",
      },
    }),
  ],
  state: CertifiedContext["state"] = "active",
  revision = "1",
): CertifiedContext {
  const content = {
    tenantId: "tenant-1",
    target: "support-agent",
    state,
    revision,
    entries,
  };
  return {
    ...content,
    generatedAt,
    expiresAt,
    contentHash: certifiedContextContentHash(content),
  };
}

describe("certifiedContextSchema", () => {
  it("parses and recursively freezes exact tenant-bound context", () => {
    const value = context();
    const parsed = parseCertifiedContext(value);

    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.entries)).toBe(true);
    expect(Object.isFrozen(parsed.entries[0])).toBe(true);
    expect(Object.isFrozen(parsed.entries[0]?.delivery)).toBe(true);
  });

  it("rejects tools, credentials, profile patches, and executable metadata", () => {
    for (const removed of [
      {
        entries: [
          {
            ...context().entries[0],
            iface: { surface: "tool", name: "refund" },
          },
        ],
      },
      { tools: [] },
      { profileDiffs: [] },
      { agentProfile: null },
      { credentials: {} },
      { mcp: {} },
    ]) {
      expect(() => parseCertifiedContext({ ...context(), ...removed })).toThrow();
    }

    expect(() =>
      certifiedContextEntrySchema.parse({
        ...context().entries[1],
        delivery: {
          kind: "file",
          path: "skills/refund/SKILL.md",
          content: "Check the invoice.",
          executable: true,
        },
      }),
    ).toThrow();
  });

  it("rejects blank inline context", () => {
    expect(() =>
      certifiedContextEntrySchema.parse({
        ...context().entries[0],
        delivery: { kind: "inline", content: "   " },
      }),
    ).toThrow(/inline context cannot be blank/);
  });

  it("requires skills as files and prompts or instructions inline", () => {
    expect(() =>
      certifiedContextEntrySchema.parse({
        ...context().entries[0],
        kind: "skill",
      }),
    ).toThrow(/skills must be delivered as files/);
    expect(() =>
      certifiedContextEntrySchema.parse({
        ...context().entries[1],
        kind: "instructions",
      }),
    ).toThrow(/prompts and instructions must be delivered inline/);
  });

  it("rejects duplicate ids and file paths", () => {
    const value = context();
    expect(() =>
      certifiedContextSchema.parse({
        ...value,
        entries: [value.entries[0], value.entries[0]],
      }),
    ).toThrow(/duplicate context id/);

    const duplicateFile = entry({
      id: "refund-skill-copy",
      kind: "skill",
      name: "refund skill copy",
      delivery: {
        kind: "file",
        path: "skills/refund/SKILL.md",
        content: "Check the invoice again.",
      },
    });
    expect(() =>
      certifiedContextSchema.parse({
        ...value,
        entries: [value.entries[1], duplicateFile],
      }),
    ).toThrow(/duplicate file path/);
  });

  it("accepts safe context files and rejects unsafe paths", () => {
    expect(certifiedContextEntrySchema.parse(context().entries[1])).toEqual(
      context().entries[1],
    );
    expect(() =>
      certifiedContextEntrySchema.parse({
        ...context().entries[1],
        delivery: {
          kind: "file",
          path: "../escape.md",
          content: "unsafe",
        },
      }),
    ).toThrow(/canonical relative path/);
  });

  it("binds tenant, target, state, revision, entries, and provenance to hashes", () => {
    const value = context();
    for (const changed of [
      { tenantId: "tenant-2" },
      { target: "different-agent" },
      { state: "revoked" },
      { revision: "2" },
      { entries: [] },
    ]) {
      expect(() =>
        certifiedContextSchema.parse({ ...value, ...changed }),
      ).toThrow(/content hash|requires entries/);
    }

    expect(() =>
      certifiedContextEntrySchema.parse({
        ...value.entries[0],
        delivery: { kind: "inline", content: "tampered" },
      }),
    ).toThrow(/entry content hash does not match/);
  });

  it("limits revisions and artifact versions to exactly representable ranges", () => {
    const value = context();
    expect(
      certifiedContextSchema.safeParse({
        ...value,
        revision: "not-a-revision",
      }).success,
    ).toBe(false);
    expect(() =>
      certifiedContextSchema.parse({
        ...value,
        revision: "9223372036854775808",
      }),
    ).toThrow(/signed 64-bit range/);
    expect(() =>
      certifiedContextEntrySchema.parse({
        ...value.entries[0],
        provenance: {
          ...value.entries[0]?.provenance,
          version: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toThrow();
  });

  it("enforces lifetime and promotion ordering", () => {
    const value = context();
    const beforeGeneration = {
      ...value,
      expiresAt: "2026-07-25T19:59:00.000Z",
    };
    expect(() => certifiedContextSchema.parse(beforeGeneration)).toThrow(
      /expiresAt must be after/,
    );

    const tooLong = {
      ...value,
      expiresAt: "2026-07-27T20:01:00.000Z",
    };
    expect(() => certifiedContextSchema.parse(tooLong)).toThrow(
      /cannot live longer than 15 minutes/,
    );

    const late = entry({
      id: "late",
      kind: "prompt",
      name: "late",
      delivery: { kind: "inline", content: "late" },
    });
    const lateEntry = {
      ...late,
      provenance: {
        ...late.provenance,
        promotedAt: "2026-07-25T20:02:00.000Z",
      },
    };
    const lateContext = context([lateEntry]);
    expect(() => certifiedContextSchema.parse(lateContext)).toThrow(
      /cannot be promoted after bundle generation/,
    );
  });

  it("bounds entry content, entry count, and complete response bytes", () => {
    expect(() =>
      certifiedContextEntrySchema.parse({
        ...context().entries[0],
        delivery: {
          kind: "inline",
          content: "x".repeat(65_537),
        },
      }),
    ).toThrow();

    const tooMany = Array.from({ length: 129 }, (_, index) =>
      entry({
        id: `entry-${index}`,
        kind: "instructions",
        name: `entry-${index}`,
        delivery: { kind: "inline", content: "x" },
      }),
    );
    expect(() => certifiedContextSchema.parse(context(tooMany))).toThrow();

    const oversized = Array.from({ length: 16 }, (_, index) =>
      entry({
        id: `large-${index}`,
        kind: "skill",
        name: `large-${index}`,
        delivery: {
          kind: "file",
          path: `skills/large-${index}/SKILL.md`,
          content: "x".repeat(1_048_576),
        },
      }),
    );
    expect(() => certifiedContextSchema.parse(context(oversized))).toThrow(
      /serialized context exceeds/,
    );
  });

  it("caps cumulative inline context separately from file payloads", () => {
    const entries = Array.from({ length: 3 }, (_, index) =>
      entry({
        id: `inline-${index}`,
        kind: "instructions",
        name: `inline-${index}`,
        delivery: {
          kind: "inline",
          content: "x".repeat(50_000),
        },
      }),
    );
    expect(() => certifiedContextSchema.parse(context(entries))).toThrow(
      /inline context exceeds 131072/,
    );
  });

  it("represents revocation as a revisioned empty response", () => {
    const revoked = context([], "revoked", "9");
    expect(parseCertifiedContext(revoked)).toEqual(revoked);
    expect(() => certifiedContextSchema.parse(context([], "active", "9"))).toThrow(
      /active context requires entries/,
    );
    expect(() =>
      certifiedContextSchema.parse(context([context().entries[0]!], "revoked", "9")),
    ).toThrow(/revoked context requires none/);
  });
});
