import { describe, expect, it } from "vitest";
import {
  defineGitHubResource,
  mergeAgentProfiles,
  type AgentProfile,
} from "./agent-profile.js";
import {
  applyAgentProfileDiff,
  pruneAgentProfileDiff,
} from "./profile-diff.js";
import { canonicalCandidateJson } from "./agent-candidate-schema-common.js";

/**
 * Own keys carrying `undefined`, as profile paths.
 *
 * RFC 8785 canonicalization enumerates own keys, so `{ tools: undefined }` and
 * `{}` are different documents even though they describe the same profile. A
 * profile-producing helper that writes the first shape moves the profile digest
 * without changing any profile content.
 */
function undefinedKeyPaths(value: unknown, path = "root"): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      undefinedKeyPaths(entry, `${path}[${index}]`),
    );
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    entry === undefined
      ? [`${path}.${key}`]
      : undefinedKeyPaths(entry, `${path}.${key}`),
  );
}

const base: AgentProfile = {
  name: "base",
  harness: "claude-code",
  prompt: { systemPrompt: "Stand-alone prompt." },
  tools: { read: true },
};

const overlay: AgentProfile = {
  description: "overlay",
  prompt: { instructions: ["Cite the file you read."] },
  resources: { skills: [defineGitHubResource("skills/audit/SKILL.md")] },
};

describe("merged profiles stay canonicalizable", () => {
  it("omits every optional key it resolves to undefined", () => {
    expect(undefinedKeyPaths(mergeAgentProfiles(base, overlay))).toEqual([]);
    expect(undefinedKeyPaths(mergeAgentProfiles(base, undefined))).toEqual([]);
    expect(undefinedKeyPaths(mergeAgentProfiles(undefined, overlay))).toEqual([]);
    expect(undefinedKeyPaths(mergeAgentProfiles({}, {}))).toEqual([]);
    expect(
      undefinedKeyPaths(
        mergeAgentProfiles({ name: "only" }, { description: "only" }),
      ),
    ).toEqual([]);
  });

  it("serializes under the RFC 8785 canonicalization used for profile digests", () => {
    const merged = mergeAgentProfiles(base, overlay);

    expect(canonicalCandidateJson(merged)).toBe(
      canonicalCandidateJson({
        name: "base",
        description: "overlay",
        harness: "claude-code",
        prompt: {
          systemPrompt: "Stand-alone prompt.",
          instructions: ["Cite the file you read."],
        },
        tools: { read: true },
        resources: {
          skills: [{ kind: "github", path: "skills/audit/SKILL.md" }],
        },
      }),
    );
  });

  it("digests a merge of a merge identically to the merge itself", () => {
    const merged = mergeAgentProfiles(base, overlay);

    expect(canonicalCandidateJson(mergeAgentProfiles(merged, undefined))).toBe(
      canonicalCandidateJson(merged),
    );
    expect(canonicalCandidateJson(mergeAgentProfiles(undefined, merged))).toBe(
      canonicalCandidateJson(merged),
    );
  });

  it("reads an undefined overlay entry as unspecified, not as a removal", () => {
    const explicit = mergeAgentProfiles(base, {
      ...overlay,
      harness: undefined,
      tools: undefined,
      prompt: { ...overlay.prompt, systemPrompt: undefined },
    });

    expect(canonicalCandidateJson(explicit)).toBe(
      canonicalCandidateJson(mergeAgentProfiles(base, overlay)),
    );
  });

  it("keeps an undefined entry out of a merged record", () => {
    const merged = mergeAgentProfiles(
      {
        metadata: { owner: "platform" },
        extensions: { codex: { sandbox: "workspace-write" } },
      },
      { metadata: { owner: undefined }, extensions: { codex: undefined } },
    );

    expect(merged?.metadata).toStrictEqual({ owner: "platform" });
    expect(merged?.extensions).toStrictEqual({
      codex: { sandbox: "workspace-write" },
    });
    expect(undefinedKeyPaths(merged)).toEqual([]);
  });
});

describe("profile helpers omit unset optional keys", () => {
  it("builds a GitHub resource ref without unset repository, ref, or name", () => {
    expect(Object.keys(defineGitHubResource("docs/AGENTS.md")).sort()).toEqual([
      "kind",
      "path",
    ]);
    expect(
      defineGitHubResource("docs/AGENTS.md", { ref: "main" }),
    ).toStrictEqual({
      kind: "github",
      path: "docs/AGENTS.md",
      ref: "main",
    });
  });

  it("applies a diff without leaving removed axes behind as undefined", () => {
    const applied = applyAgentProfileDiff(
      {
        name: "base",
        harness: "codex",
        prompt: {
          systemPrompt: "Stand-alone prompt.",
          appendSystemPrompt: "Also cite the file you read.",
        },
        resources: { instructions: "Keep answers short.", failOnError: true },
      },
      {
        kind: "agent-profile-diff",
        remove: {
          harness: true,
          prompt: { appendSystemPrompt: true },
          resources: { instructions: true },
        },
      },
    );

    expect(undefinedKeyPaths(applied)).toEqual([]);
    expect(canonicalCandidateJson(applied)).toBe(
      canonicalCandidateJson({
        name: "base",
        prompt: { systemPrompt: "Stand-alone prompt." },
        resources: { failOnError: true },
      }),
    );
  });

  it("prunes a diff by dropping the axis rather than blanking it", () => {
    const pruned = pruneAgentProfileDiff(
      {
        kind: "agent-profile-diff",
        set: { harness: "codex" },
        remove: { tools: true },
      },
      ["harness", "tools"],
    );

    expect(undefinedKeyPaths(pruned)).toEqual([]);
    expect(pruned).toStrictEqual({ kind: "agent-profile-diff" });
  });
});
