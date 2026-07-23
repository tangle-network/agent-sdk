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

describe("agent improvement source", () => {
  it("round-trips one exact source through signed proposal metadata", () => {
    const metadata = agentImprovementSourceMetadata(source);

    expect(metadata).toEqual({
      [AGENT_IMPROVEMENT_SOURCE_METADATA_KEY]: source,
    });
    expect(readAgentImprovementSource(metadata)).toEqual(source);
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
