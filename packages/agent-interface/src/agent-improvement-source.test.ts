import { describe, expect, it } from "vitest";
import {
  AGENT_IMPROVEMENT_SOURCE_METADATA_KEY,
  agentImprovementSourceMetadata,
  agentImprovementSourceSchema,
  readAgentImprovementSource,
} from "./agent-improvement-source.js";

const source = {
  kind: "platform-agent-profile",
  sourceIdentity: "ap_reviewer",
  sourceDigest: `sha256:${"a".repeat(64)}` as const,
  sourceRevision: 17,
};

const richSource = agentImprovementSourceSchema.parse({
  ...source,
  license: { kind: "spdx", expression: "MIT OR Apache-2.0" },
  attribution: ["Copyright 2026 Example Contributors"],
  notices: ["Retain this notice in redistributed copies."],
  transformations: [
    {
      kind: "normalization",
      identity: "skill-frontmatter-normalizer",
      revision: "1.2.0",
      procedureDigest: `sha256:${"1".repeat(64)}`,
      inputDigest: `sha256:${"b".repeat(64)}`,
      outputDigest: `sha256:${"c".repeat(64)}`,
    },
    {
      kind: "transformation",
      identity: "profile-resource-importer",
      revision: 3,
      procedureDigest: `sha256:${"2".repeat(64)}`,
      inputDigest: `sha256:${"c".repeat(64)}`,
      outputDigest: source.sourceDigest,
    },
  ],
});

describe("agent improvement source", () => {
  it("round-trips one exact source through signed proposal metadata", () => {
    const metadata = agentImprovementSourceMetadata(source);

    expect(metadata).toEqual({
      [AGENT_IMPROVEMENT_SOURCE_METADATA_KEY]: source,
    });
    expect(readAgentImprovementSource(metadata)).toEqual(source);
  });

  it("retains SPDX terms, attribution, notices, and an ordered transform chain", () => {
    const metadata = agentImprovementSourceMetadata(richSource);

    expect(readAgentImprovementSource(metadata)).toEqual(richSource);
  });

  it("pins custom license terms instead of trusting a mutable label", () => {
    const custom = agentImprovementSourceSchema.parse({
      ...source,
      license: {
        kind: "custom",
        name: "Example Research License 1.0",
        reference: "LICENSES/Example-Research-1.0.txt",
        termsDigest: `sha256:${"d".repeat(64)}`,
      },
    });

    expect(custom.license).toEqual({
      kind: "custom",
      name: "Example Research License 1.0",
      reference: "LICENSES/Example-Research-1.0.txt",
      termsDigest: `sha256:${"d".repeat(64)}`,
    });
    expect(() =>
      agentImprovementSourceSchema.parse({
        ...custom,
        license: { kind: "custom", name: "mutable label only" },
      }),
    ).toThrow();
  });

  it("keeps credentials and malformed Unicode out of public source evidence", () => {
    const customLicense = {
      kind: "custom" as const,
      name: "Example Research License 1.0",
      reference: "LICENSES/Example-Research-1.0.txt",
      termsDigest: `sha256:${"d".repeat(64)}` as const,
    };
    const unsafeSources = [
      {
        ...source,
        license: {
          ...customLicense,
          reference: "https://user:pa55@example.test/LICENSE",
        },
      },
      {
        ...source,
        license: {
          ...customLicense,
          reference: "https://example.test/LICENSE?token=plaintext",
        },
      },
      { ...source, attribution: ["ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcd"] },
      { ...source, sourceIdentity: "https://user:pa55@example.test/profile" },
      { ...source, sourceRevision: "sk-live-abcdefghijkl" },
      { ...source, notices: ["Bearer eyJabc.def.ghi"] },
      { ...source, notices: ["AKIAIOSFODNN7EXAMPLE secret"] },
      { ...source, attribution: ["Copyright x\uD800y"] },
      {
        ...source,
        license: { ...customLicense, name: "License x\uD800y" },
      },
      {
        ...source,
        license: { ...customLicense, reference: "LICENSES/x\uD800y.txt" },
      },
    ];

    for (const unsafeSource of unsafeSources) {
      expect(agentImprovementSourceSchema.safeParse(unsafeSource).success).toBe(
        false,
      );
    }
  });

  it("rejects invalid SPDX expressions and disconnected transformation evidence", () => {
    expect(() =>
      agentImprovementSourceSchema.parse({
        ...source,
        license: { kind: "spdx", expression: "MIT SOMETIMES Apache-2.0" },
      }),
    ).toThrow(/standard SPDX/);

    expect(() =>
      agentImprovementSourceSchema.parse({
        ...source,
        license: { kind: "spdx", expression: "LicenseRef-Mutable-Terms" },
      }),
    ).toThrow(/content-pin custom terms/);

    expect(() =>
      agentImprovementSourceSchema.parse({
        ...richSource,
        transformations: [
          richSource.transformations?.[0],
          {
            ...richSource.transformations?.[1],
            inputDigest: `sha256:${"e".repeat(64)}`,
          },
        ],
      }),
    ).toThrow(/previous output/);

    expect(() =>
      agentImprovementSourceSchema.parse({
        ...richSource,
        transformations: richSource.transformations?.map(
          ({ procedureDigest: _procedureDigest, ...transformation }) =>
            transformation,
        ),
      }),
    ).toThrow();

    expect(() =>
      agentImprovementSourceSchema.parse({
        ...richSource,
        sourceDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow(/final transformation output/);
  });

  it("rejects missing, lossy, and malformed source references", () => {
    expect(() => readAgentImprovementSource({})).toThrow(
      /missing its source reference/,
    );
    expect(() =>
      agentImprovementSourceSchema.parse({
        ...source,
        sourceDigest: "sha256:not-a-digest",
      }),
    ).toThrow();
    expect(
      agentImprovementSourceSchema.parse({
        ...source,
        sourceRevision: "git:abc123",
      }),
    ).toMatchObject({ sourceRevision: "git:abc123" });
    expect(() =>
      agentImprovementSourceSchema.parse({ ...source, unexpected: true }),
    ).toThrow();
  });
});
