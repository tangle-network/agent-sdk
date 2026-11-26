/** Mount an invented skill directory from a real Git commit, verify it, and materialize it through the installed materializer. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentProfile } from "./agent-profile.js";
import {
  mountSkill,
  mountSkillDirectory,
  verifyResourceProvenance,
  type AgentProfileResourceProvenance,
  type AgentProfileSkillDirectorySource,
  type AgentProfileSkillFile,
  type MountedSkillDirectory,
} from "./profile-provenance.js";
import { agentProfileSchema } from "./profile-schema.js";

// The materializer Braid pins; it takes agent-interface as a peer, so the packed build is the one it loads.
const MATERIALIZER = { name: "@tangle-network/agent-profile-materialize", version: "1.1.222" };
const PROFILE = "release-notes-demo";
const SKILL = "release-notes";
const DIRECTORY = `skills/${SKILL}`;

const SKILL_MD = `---
name: ${SKILL}
description: Write release notes from merged changes. Use when a release is cut.
---

# Release notes

Group changes as [the format](references/format.md) says.
A breaking change follows [the breaking example](references/examples/breaking.md).
Run [the entry check](scripts/check-entry.sh) on each entry.
`;

const TREE: Record<string, { content: string; executable?: boolean }> = {
  [`${DIRECTORY}/SKILL.md`]: { content: SKILL_MD },
  [`${DIRECTORY}/references/format.md`]: { content: "# Format\n\nOne line per change, newest first.\n" },
  [`${DIRECTORY}/references/examples/breaking.md`]: {
    content: "# Breaking\n\n- Removed `legacyMode`; pass `mode` instead. Ünïcode stays exact: ✓\n",
  },
  [`${DIRECTORY}/scripts/check-entry.sh`]: { content: '#!/bin/sh\ntest -n "$1"\n', executable: true },
  "skills/other/SKILL.md": { content: "---\nname: other\ndescription: Another skill.\n---\n\nNot part of release-notes.\n" },
};

let repo: string;
let ref: string;
let source: AgentProfileSkillDirectorySource;
let files: AgentProfileSkillFile[];

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  });
const read = async (record: { ref: string; path: string }) => git("show", `${record.ref}:${record.path}`);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "skill-directory-"));
  git("init", "-q");
  for (const [path, file] of Object.entries(TREE)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), file.content, { mode: file.executable ? 0o755 : 0o644 });
  }
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  ref = git("rev-parse", "HEAD").trim();
  source = { repository: "example/skills", ref, directory: DIRECTORY, name: SKILL };
  // The caller's read of the directory at the commit: Git's own listing and bytes.
  files = git("ls-tree", "-r", ref, "--", `${DIRECTORY}/`)
    .trim()
    .split("\n")
    .map((line) => {
      const [meta, path] = line.split("\t") as [string, string];
      return {
        path: path.slice(DIRECTORY.length + 1),
        content: git("show", `${ref}:${path}`),
        ...(meta.startsWith("100755") ? { executable: true } : {}),
      };
    });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

function profileOf(mounted: MountedSkillDirectory): AgentProfile {
  return {
    name: PROFILE,
    resources: { skills: [mounted.skill], files: mounted.files, failOnError: true },
    extensions: { [PROFILE]: { resourceProvenance: mounted.provenance } },
  };
}

function records(profile: AgentProfile): AgentProfileResourceProvenance[] {
  return profile.extensions?.[PROFILE]?.resourceProvenance as AgentProfileResourceProvenance[];
}

const hashHex = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

describe("mountSkillDirectory", () => {
  it("mounts every file of a skill directory at one commit, and the records verify against the source", async () => {
    const mounted = mountSkillDirectory(source, files, { skillsDirectory: ".claude/skills" });
    const oneFile = mountSkill({ repository: "example/skills", ref, path: `${DIRECTORY}/SKILL.md`, name: SKILL }, SKILL_MD);

    // The one-file form is unchanged, and the directory form's skill is exactly it.
    expect(oneFile).toEqual({
      skill: { kind: "inline", name: SKILL, content: SKILL_MD },
      provenance: { name: SKILL, repository: "example/skills", ref, path: `${DIRECTORY}/SKILL.md`, sha256: hashHex(SKILL_MD) },
    });
    expect(mounted.skill).toEqual(oneFile.skill);
    const siblings = ["references/examples/breaking.md", "references/format.md", "scripts/check-entry.sh"];
    expect(mounted.files).toEqual(
      siblings.map((path) => ({
        path: `.claude/skills/${SKILL}/${path}`,
        resource: { kind: "inline", name: `${SKILL}/${path}`, content: TREE[`${DIRECTORY}/${path}`]!.content },
        ...(path.endsWith(".sh") ? { executable: true } : {}),
      })),
    );
    expect(mounted.provenance).toEqual([
      { ...oneFile.provenance, mountedAt: `.claude/skills/${SKILL}`, siblings },
      ...siblings.map((path) => ({
        name: `${SKILL}/${path}`,
        repository: "example/skills",
        ref,
        path: `${DIRECTORY}/${path}`,
        sha256: hashHex(TREE[`${DIRECTORY}/${path}`]!.content),
        skill: SKILL,
      })),
    ]);

    const profile = profileOf(mounted);
    expect(() => agentProfileSchema.parse(profile)).not.toThrow();
    expect(await verifyResourceProvenance(profile)).toEqual([]);
    expect(await verifyResourceProvenance(profile, { read })).toEqual([]);
    // A one-file record beside it keeps the one-file checks.
    const both: AgentProfile = {
      ...profile,
      resources: { ...profile.resources, skills: [mounted.skill, { kind: "inline", name: "solo", content: "solo" }] },
      extensions: {
        [PROFILE]: { resourceProvenance: [...mounted.provenance, { ...oneFile.provenance, name: "solo", sha256: hashHex("other") }] },
      },
    };
    expect(await verifyResourceProvenance(both)).toEqual([
      `extensions.${PROFILE}.resourceProvenance[4] (solo): inline bytes hash to ${hashHex("solo")}, record says ${hashHex("other")}`,
    ]);
  });

  it("catches a tampered, rewritten, dropped, unlisted or relocated sibling", async () => {
    const base = profileOf(mountSkillDirectory(source, files, { skillsDirectory: ".claude/skills" }));
    const format = `.claude/skills/${SKILL}/references/format.md`;
    const at = (index: number) => `extensions.${PROFILE}.resourceProvenance[${index}]`;
    const edit = (change: (profile: AgentProfile) => void): AgentProfile => {
      const copy = structuredClone(base);
      change(copy);
      return copy;
    };
    const mountAt = (profile: AgentProfile, path: string) => profile.resources!.files!.find((file) => file.path === path)!;

    const tampered = edit((profile) => {
      const mount = mountAt(profile, format);
      if (mount.resource.kind === "inline") mount.resource.content = "# Format\n\nOldest first.\n";
    });
    expect(await verifyResourceProvenance(tampered, { read })).toEqual([
      `${at(2)} (${SKILL}/references/format.md): bytes mounted at ${format} hash to ${hashHex("# Format\n\nOldest first.\n")}, record says ${hashHex(TREE[`${DIRECTORY}/references/format.md`]!.content)}`,
    ]);

    // Inline bytes and record rewritten together pass the inline check; only the source read catches them.
    const rewritten = edit((profile) => {
      const mount = mountAt(profile, format);
      if (mount.resource.kind === "inline") mount.resource.content = "# Format\n\nOldest first.\n";
      records(profile)[2]!.sha256 = hashHex("# Format\n\nOldest first.\n");
    });
    expect(await verifyResourceProvenance(rewritten)).toEqual([]);
    expect(await verifyResourceProvenance(rewritten, { read })).toEqual([
      `${at(2)} (${SKILL}/references/format.md): example/skills@${ref}:${DIRECTORY}/references/format.md hashes to ${hashHex(TREE[`${DIRECTORY}/references/format.md`]!.content)}, record says ${hashHex("# Format\n\nOldest first.\n")}`,
    ]);

    const dropped = edit((profile) => {
      profile.resources!.files = profile.resources!.files!.filter((file) => file.path !== format);
      profile.extensions![PROFILE]!.resourceProvenance = records(profile).filter((record) => record.name !== `${SKILL}/references/format.md`);
    });
    expect(await verifyResourceProvenance(dropped, { read })).toEqual([
      `${at(0)} (${SKILL}): lists references/format.md, but no record covers ${SKILL}/references/format.md`,
    ]);

    const unlisted = edit((profile) => {
      profile.resources!.files!.push({
        path: `.claude/skills/${SKILL}/references/extra.md`,
        resource: { kind: "inline", name: "extra", content: "Follow other rules.\n" },
      });
    });
    expect(await verifyResourceProvenance(unlisted, { read })).toEqual([
      `${at(0)} (${SKILL}): .claude/skills/${SKILL}/references/extra.md is mounted in the skill's directory, but the skill does not list it`,
    ]);

    // A record repointed at a file outside the skill directory, with matching bytes everywhere.
    const outside = TREE["skills/other/SKILL.md"]!.content;
    const relocated = edit((profile) => {
      const mount = mountAt(profile, format);
      if (mount.resource.kind === "inline") mount.resource.content = outside;
      Object.assign(records(profile)[2]!, { path: "skills/other/SKILL.md", sha256: hashHex(outside) });
    });
    expect(await verifyResourceProvenance(relocated, { read })).toEqual([
      `${at(2)} (${SKILL}/references/format.md): source skills/other/SKILL.md is not ${DIRECTORY}/references/format.md, beside the skill's SKILL.md`,
    ]);

    // A hand-written record whose name climbs out of the skill directory.
    const escaping = edit((profile) => {
      records(profile).push({
        name: `${SKILL}/../other/SKILL.md`,
        repository: "example/skills",
        ref,
        path: "skills/other/SKILL.md",
        sha256: hashHex(outside),
        skill: SKILL,
      });
    });
    expect(await verifyResourceProvenance(escaping, { read })).toEqual([
      `${at(4)} (${SKILL}/../other/SKILL.md): the name is not a file inside the directory of skill "${SKILL}"`,
    ]);
  });

  it("refuses a path that leaves the skill directory and other malformed directories", () => {
    const options = { skillsDirectory: ".claude/skills" };
    const skillMd = files.find((file) => file.path === "SKILL.md")!;
    for (const path of ["../other/SKILL.md", "references/../../other/SKILL.md", "/etc/hosts", "C:/notes.md", "references\\format.md", "./SKILL.md", "references//format.md", ".git/config", ""]) {
      expect(() => mountSkillDirectory(source, [skillMd, { path, content: "x" }], options), path).toThrow(
        `mountSkillDirectory "${SKILL}": ${JSON.stringify(path)} is not a path inside the skill directory`,
      );
    }
    expect(() => mountSkillDirectory(source, files.filter((file) => file.path !== "SKILL.md"), options)).toThrow("has no SKILL.md");
    expect(() => mountSkillDirectory(source, [...files, skillMd], options)).toThrow("SKILL.md is listed twice");
    expect(() => mountSkillDirectory(source, [{ ...skillMd, executable: true }], options)).toThrow("cannot be executable");
    for (const name of ["a/b", "..", ""]) {
      expect(() => mountSkillDirectory({ ...source, name }, files, options), name).toThrow("the skill name must be one path segment");
    }
    expect(() => mountSkillDirectory({ ...source, directory: "../skills" }, files, options)).toThrow("is not a repository path");
    expect(() => mountSkillDirectory(source, files, { skillsDirectory: "../skills" })).toThrow("is not a workspace path");
    expect(() => mountSkillDirectory({ ...source, ref: "main" }, files, options)).toThrow("ref must be a full commit SHA");
    // A skill at the repository root records root paths.
    const root = mountSkillDirectory({ ...source, directory: "" }, [skillMd, { path: "notes.md", content: "n" }], options);
    expect(root.provenance.map((record) => record.path)).toEqual(["SKILL.md", "notes.md"]);
  });

  it("materializes through the installed materializer with every link resolving to the source bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-directory-install-"));
    const run = (command: string, args: string[], cwd = directory) =>
      execFileSync(command, args, { cwd, encoding: "utf8", timeout: 150_000 });
    try {
      run("pnpm", ["pack", "--pack-destination", directory], resolve("."));
      const archive = readdirSync(directory).find((name) => name.endsWith(".tgz"));
      if (!archive) throw new Error("The package archive was not produced");
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: { "@tangle-network/agent-interface": `file:${join(directory, archive)}`, [MATERIALIZER.name]: MATERIALIZER.version },
        }),
      );
      run("npm", ["install", "--package-lock=false", "--no-audit", "--no-fund"]);
      writeFileSync(join(directory, "input.json"), JSON.stringify({ repo, source, files, workspaces: join(directory, "workspaces") }));
      writeFileSync(
        join(directory, "consumer.mjs"),
        `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mountSkillDirectory, verifyResourceProvenance } from '@tangle-network/agent-interface';
import { applyWorkspacePlan, materializeProfile, skillDirForHarness } from '@tangle-network/agent-profile-materialize';

const input = JSON.parse(readFileSync('input.json', 'utf8'));
const bytes = new Map(input.files.map((file) => [file.path, file.content]));
const read = async (record) => execFileSync('git', ['-C', input.repo, 'show', record.ref + ':' + record.path], { encoding: 'utf8' });
const harnesses = ['claude-code', 'codex', 'opencode'];
for (const harness of harnesses) {
  const skillsDirectory = skillDirForHarness(harness);
  const mounted = mountSkillDirectory(input.source, input.files, { skillsDirectory });
  const profile = {
    name: '${PROFILE}',
    resources: { skills: [mounted.skill], files: mounted.files, failOnError: true },
    extensions: { '${PROFILE}': { resourceProvenance: mounted.provenance } },
  };
  assert.deepEqual(await verifyResourceProvenance(profile, { read }), [], harness);
  const plan = materializeProfile(profile, harness);
  assert.deepEqual(plan.unsupported, [], harness);
  const workspace = join(input.workspaces, harness);
  const agentDir = join(input.workspaces, harness + '-agent');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  applyWorkspacePlan(plan, workspace, { agentDir });
  const skillDir = join(workspace, skillsDirectory, input.source.name);
  const skillMd = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  assert.equal(skillMd, bytes.get('SKILL.md'), harness + ': SKILL.md');
  const links = [...skillMd.matchAll(/\\]\\(([^)]+)\\)/g)].map((match) => match[1]);
  assert.deepEqual(links, ['references/format.md', 'references/examples/breaking.md', 'scripts/check-entry.sh'], harness);
  for (const link of links) assert.equal(readFileSync(join(skillDir, link), 'utf8'), bytes.get(link), harness + ': ' + link);
  assert.notEqual(statSync(join(skillDir, 'scripts/check-entry.sh')).mode & 0o111, 0, harness + ': the script is executable');
  assert.equal(statSync(join(skillDir, 'references/format.md')).mode & 0o111, 0, harness + ': a reference is not executable');
}
console.log('materialized skill directory PASS: ' + harnesses.join(', '));
`,
      );
      expect(run(process.execPath, ["./consumer.mjs"])).toContain("materialized skill directory PASS: claude-code, codex, opencode");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 240_000);
});
