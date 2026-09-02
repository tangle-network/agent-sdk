import { describe, expect, it } from "vitest";
import { agentCandidateLineageSchema } from "./agent-candidate-lineage-schema.js";

const parent =
  "sha256:845210857c1eaac5e0a9e264b87848a10176587cc14d22699ae17ce0fe504931" as const;
const other =
  "sha256:38076af9d4591eff7d71291f492f872f3abce6d8ae07e7558c7fbae4395a2f28" as const;
const split =
  "sha256:0b48b914a1eb23a5af363a896d9be3747f5f4019a6b2927df9216a9899282067" as const;

const issuePaths = (result: { success: boolean; error?: unknown }): string[] =>
  result.success
    ? []
    : (result.error as { issues: { path: PropertyKey[] }[] }).issues.map(
        (issue) => issue.path.join("."),
      );

describe("agentCandidateLineageSchema", () => {
  it("accepts a hand-written lineage with no ancestry", () => {
    expect(
      agentCandidateLineageSchema.safeParse({ source: "human" }).success,
    ).toBe(true);
  });

  it("requires an optimizer lineage to name a parent, a run and its development split", () => {
    expect(issuePaths(agentCandidateLineageSchema.safeParse({ source: "optimizer" })))
      .toEqual(["parentDigests", "runIds", "developmentSplitDigest"]);
    expect(
      agentCandidateLineageSchema.safeParse({
        source: "optimizer",
        parentDigests: [parent],
        runIds: ["run-1"],
        developmentSplitDigest: split,
      }).success,
    ).toBe(true);
  });

  it("requires a compound lineage to name two distinct parents", () => {
    expect(
      issuePaths(
        agentCandidateLineageSchema.safeParse({
          source: "compound",
          parentDigests: [parent],
          runIds: ["run-1"],
          developmentSplitDigest: split,
        }),
      ),
    ).toEqual(["parentDigests"]);
    expect(
      agentCandidateLineageSchema.safeParse({
        source: "compound",
        parentDigests: [parent, other],
        runIds: ["run-1"],
        developmentSplitDigest: split,
      }).success,
    ).toBe(true);
  });

  it("accepts an agent-authored lineage without a development split", () => {
    // A supervising agent writes a child's profile from inside a run. There is
    // no held-out split behind it, and none is required; the parent and the
    // producing run still are, so the ancestry stays checkable.
    expect(
      agentCandidateLineageSchema.safeParse({
        source: "agent-author",
        parentDigests: [parent],
        runIds: ["director-conj-r46-round-1"],
        profileDiffIds: ["38076af9d459-0"],
      }).success,
    ).toBe(true);
  });

  it("still requires an agent-authored lineage to name its parent and its run", () => {
    expect(
      issuePaths(agentCandidateLineageSchema.safeParse({ source: "agent-author" })),
    ).toEqual(["parentDigests", "runIds"]);
  });

  it("refuses duplicate entries in any ancestry list", () => {
    expect(
      issuePaths(
        agentCandidateLineageSchema.safeParse({
          source: "agent-author",
          parentDigests: [parent, parent],
          runIds: ["run-1", "run-1"],
        }),
      ),
    ).toEqual(["parentDigests.1", "runIds.1"]);
  });
});
