import { describe, expect, it } from "vitest";
import { agentProfileSchema, agentProfileKnowledgeRefSchema } from "./profile-schema.js";
import { type AgentProfile, mergeAgentProfiles } from "./agent-profile.js";
import { snapshotAgentProfile } from "./agent-profile-snapshot.js";
import { applyAgentProfileDiff, diffAgentProfiles } from "./profile-diff.js";
import { profileMaterializationAxes } from "./agent-profile-materialization.js";
import { agentCandidateResourcesSchema } from "./agent-candidate-artifact-schema.js";
import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";
const first = { sourceId: "source_1", generation: `kg_${"a".repeat(64)}` };
const second = { sourceId: "source_1", generation: `kg_${"b".repeat(64)}` };
const profile = { resources: { knowledge: [first] } };
describe("canonical immutable knowledge identity", () => {
  it("survives profile/candidate intake and snapshot and contributes to identity", () => {
    expect(agentProfileSchema.parse(profile)).toEqual(profile);
    expect(agentCandidateResourcesSchema.parse({ ...profile.resources, failOnError: true }).knowledge).toEqual([first]);
    const snapshot = snapshotAgentProfile(profile);
    expect(snapshot).toEqual(profile);
    expect(Object.isFrozen(snapshot.resources!.knowledge![0])).toBe(true);
    expect(canonicalCandidateDigest(profile)).not.toBe(canonicalCandidateDigest({ resources: { knowledge: [second] } }));
    expect(profileMaterializationAxes(profile)).toContain("knowledge");
  });
  it.each([
    { sourceId: "source_1", generation: "latest" },
    { ...first, ownerId: "other" }, { ...first, sandboxId: "other" },
    { ...first, content: "corpus bytes" }, { ...first, sourceId: " " },
  ])("rejects mutable identities and authority or corpus fields", ref => {
    expect(agentProfileKnowledgeRefSchema.safeParse(ref).success).toBe(false);
  });
  it("rejects duplicate source pins and excessive attachments", () => {
    expect(agentProfileSchema.safeParse({ resources: { knowledge: [first, second] } }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ resources: { knowledge: Array.from({ length: 17 }, (_, i) => ({ ...first, sourceId: `s${i}` })) } }).success).toBe(false);
  });
  it("overlays explicitly repin one source without duplicating it", () => {
    const merged = mergeAgentProfiles(profile, { resources: { knowledge: [second] } });
    expect(agentProfileSchema.parse(merged).resources?.knowledge).toEqual([second]);
    expect(profile.resources.knowledge).toEqual([first]);
  });
  it("round-trips immutable generation updates and removals through the public diff", () => {
    for (const next of [{ resources: { knowledge: [second] } }, { resources: { knowledge: [] } }, {}]) {
      const actual = diffAgentProfiles(profile, next).reduce<AgentProfile>((value, diff) => applyAgentProfileDiff(value, diff), profile);
      expect(actual).toEqual(next);
    }
    expect(applyAgentProfileDiff(profile, { kind: "agent-profile-diff", remove: { resources: { knowledge: [first.sourceId] } } })).toEqual({});
  });
});
