/**
 * Provenance for inline profile resources.
 *
 * A profile that must materialize synchronously carries its skills as exact
 * inline bytes. The record beside each one names the file and commit the bytes
 * came from and their SHA-256, so an edit to either the inline copy or the
 * source shows up as a mismatch instead of a silent change of behavior.
 * Records live at `extensions[<profile name>].resourceProvenance`.
 *
 * A skill is usually a directory: `SKILL.md` links sibling files such as
 * `references/format.md` by relative path. `mountSkillDirectory` mounts the
 * whole directory: `SKILL.md` as the skill, and every other file as a
 * `resources.files` entry at the same relative path under the directory the
 * harness discovers the skill in, so the links resolve after materialization.
 */

import {
  gitObjectSchema,
  isSafeRelativePath,
  sha256Utf8,
} from "./agent-candidate-schema-common.js";
import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileResourceRef,
} from "./agent-profile.js";

/** One file at one commit. */
export interface AgentProfileResourceSource {
  /** `owner/repo`. */
  repository: string;
  /** Full commit SHA: a branch or tag can move under the recorded bytes. */
  ref: string;
  path: string;
}

/** The record a profile keeps for one inline resource. */
export interface AgentProfileResourceProvenance extends AgentProfileResourceSource {
  /**
   * Name of the inline resource the bytes were mounted as. For a file of a
   * skill directory it is `<skill>/<path relative to the skill directory>`.
   */
  name: string;
  /** Lowercase hex SHA-256 of the content's UTF-8 bytes. */
  sha256: string;
  /**
   * Set on a skill mounted with its directory: the workspace directory its
   * other files are mounted in, `<skillsDirectory>/<skill name>`.
   */
  mountedAt?: string;
  /**
   * Set with `mountedAt`: every other file of the skill directory, relative to
   * it and sorted. `[]` claims `SKILL.md` is the whole directory.
   */
  siblings?: string[];
  /** Set on a file of a skill directory: the name of the skill it belongs to. */
  skill?: string;
}

export type AgentProfileInlineResource = Extract<AgentProfileResourceRef, { kind: "inline" }>;

/** Reads the exact bytes of a source file, e.g. `git show <ref>:<path>` or the GitHub contents API. */
export type ReadAgentProfileResourceSource = (
  source: AgentProfileResourceSource,
) => Promise<string>;

/** Mount `content` as an inline skill and return the provenance record to keep beside it. */
export function mountSkill(
  source: AgentProfileResourceSource & { name: string },
  content: string,
): { skill: AgentProfileInlineResource; provenance: AgentProfileResourceProvenance } {
  if (!gitObjectSchema.safeParse(source.ref).success) {
    throw new Error(`mountSkill ${source.name}: ref must be a full commit SHA, got "${source.ref}"`);
  }
  return {
    skill: { kind: "inline", name: source.name, content },
    provenance: {
      name: source.name,
      repository: source.repository,
      ref: source.ref,
      path: source.path,
      sha256: contentSha256(content),
    },
  };
}

/** A skill directory at one commit. */
export interface AgentProfileSkillDirectorySource {
  /** `owner/repo`. */
  repository: string;
  /** Full commit SHA every file was read at. */
  ref: string;
  /** The skill directory in the repository, such as `skills/release-notes`; `""` is the repository root. */
  directory: string;
  /** The skill's name. It is one path segment: the materializer mounts `SKILL.md` at `<skills directory>/<name>/SKILL.md`. */
  name: string;
}

/** One file of a skill directory, with its path relative to that directory. */
export interface AgentProfileSkillFile {
  /** `SKILL.md`, or a sibling such as `references/format.md`. */
  path: string;
  /** The file's exact text at the commit. Binary files have no lossless inline form; mount them by GitHub ref. */
  content: string;
  /** Mount the file executable, as Git mode 100755 records it. A skill's `SKILL.md` has no mode. */
  executable?: boolean;
}

export interface MountSkillDirectoryOptions {
  /**
   * The workspace directory the profile's harness discovers skills in, such as
   * `.claude/skills`. The materializer mounts an inline skill at
   * `<this>/<name>/SKILL.md` for the harness it targets, so siblings must be
   * mounted under the same directory for relative links to resolve.
   */
  skillsDirectory: string;
}

export interface MountedSkillDirectory {
  /** `SKILL.md` as an inline skill, exactly as `mountSkill` returns it. */
  skill: AgentProfileInlineResource;
  /** Every other file, sorted by path, mounted at `<skillsDirectory>/<name>/<path>` as an inline resource named `<name>/<path>`. */
  files: AgentProfileFileMount[];
  /** The skill's record, carrying `mountedAt` and `siblings`, then one record per file in `files` order. */
  provenance: AgentProfileResourceProvenance[];
}

/**
 * Mount a skill directory read at one commit: `SKILL.md` as an inline skill
 * and every other file as an inline `resources.files` mount beside it, with a
 * provenance record for each file. Throws on a ref that is not a full commit
 * SHA, a path that leaves the skill directory, a duplicate path, or a
 * directory without `SKILL.md`.
 */
export function mountSkillDirectory(
  source: AgentProfileSkillDirectorySource,
  files: readonly AgentProfileSkillFile[],
  options: MountSkillDirectoryOptions,
): MountedSkillDirectory {
  const at = `mountSkillDirectory ${JSON.stringify(source.name)}`;
  if (!isSafeRelativePath(source.name, false) || source.name.includes("/")) {
    throw new Error(`${at}: the skill name must be one path segment`);
  }
  if (source.directory !== "" && !isSafeRelativePath(source.directory, false)) {
    throw new Error(`${at}: directory ${JSON.stringify(source.directory)} is not a repository path`);
  }
  if (!isSafeRelativePath(options.skillsDirectory, false)) {
    throw new Error(`${at}: skillsDirectory ${JSON.stringify(options.skillsDirectory)} is not a workspace path`);
  }
  let skillFile: AgentProfileSkillFile | undefined;
  const siblings: AgentProfileSkillFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafeRelativePath(file.path, false)) {
      throw new Error(`${at}: ${JSON.stringify(file.path)} is not a path inside the skill directory`);
    }
    if (seen.has(file.path)) throw new Error(`${at}: ${file.path} is listed twice`);
    seen.add(file.path);
    if (file.path !== SKILL_FILE) {
      siblings.push(file);
    } else if (file.executable === true) {
      throw new Error(`${at}: ${SKILL_FILE} mounts as a skill, which cannot be executable`);
    } else {
      skillFile = file;
    }
  }
  if (skillFile === undefined) throw new Error(`${at}: the skill directory has no ${SKILL_FILE}`);
  siblings.sort((left, right) => compare(left.path, right.path));

  const sourcePath = (relative: string) =>
    source.directory === "" ? relative : `${source.directory}/${relative}`;
  const mountedAt = `${options.skillsDirectory}/${source.name}`;
  const { skill, provenance } = mountSkill(
    { repository: source.repository, ref: source.ref, path: sourcePath(SKILL_FILE), name: source.name },
    skillFile.content,
  );
  return {
    skill,
    files: siblings.map((file) => ({
      path: `${mountedAt}/${file.path}`,
      resource: { kind: "inline", name: `${source.name}/${file.path}`, content: file.content },
      ...(file.executable === true ? { executable: true } : {}),
    })),
    provenance: [
      { ...provenance, mountedAt, siblings: siblings.map((file) => file.path) },
      ...siblings.map((file) => ({
        name: `${source.name}/${file.path}`,
        repository: source.repository,
        ref: source.ref,
        path: sourcePath(file.path),
        sha256: contentSha256(file.content),
        skill: source.name,
      })),
    ],
  };
}

/**
 * Every reason a profile's provenance records do not hold; empty when they do.
 *
 * Each record must be pinned to a commit and name inline resources whose bytes
 * hash to it. Inline resources without a record are not checked: a record is
 * the producer's claim, and only claims are verified. With `read`, the source file at that commit must hash to it too,
 * which catches a record that was rewritten together with the inline copy.
 *
 * A skill mounted with its directory claims the whole directory: each file it
 * lists must have a record at the skill's commit and source directory, the
 * same relative path inside the skill, and exact inline bytes mounted at
 * `<mountedAt>/<path>`; no other file may be mounted inside `mountedAt`.
 */
export async function verifyResourceProvenance(
  profile: AgentProfile,
  options: { namespace?: string; read?: ReadAgentProfileResourceSource } = {},
): Promise<string[]> {
  const namespace = options.namespace ?? profile.name;
  if (namespace === undefined) return ["profile has no name to locate its provenance records"];
  const records = profile.extensions?.[namespace]?.resourceProvenance;
  if (records === undefined) return [];
  if (!Array.isArray(records)) return [`extensions.${namespace}.resourceProvenance must be an array`];

  const inline = inlineResourcesByName(profile);
  const problems: string[] = [];
  const checked: CheckedRecord[] = [];
  for (const [index, record] of records.entries()) {
    const at = `extensions.${namespace}.resourceProvenance[${index}]`;
    if (!isProvenanceRecord(record)) {
      problems.push(
        `${at}: needs string name, repository, ref, path and a 64-hex sha256; mountedAt with a siblings string array, or skill, when present`,
      );
      continue;
    }
    checked.push({ at, record });
    if (!gitObjectSchema.safeParse(record.ref).success) {
      problems.push(`${at} (${record.name}): ref "${record.ref}" is not a full commit SHA`);
    }
    // A skill directory's file is checked where it is mounted, below.
    if (record.skill === undefined) {
      const mounted = inline.get(record.name) ?? [];
      if (mounted.length === 0) {
        problems.push(`${at} (${record.name}): no inline resource has this name`);
      }
      for (const content of mounted) {
        const actual = contentSha256(content);
        if (actual !== record.sha256) {
          problems.push(`${at} (${record.name}): inline bytes hash to ${actual}, record says ${record.sha256}`);
        }
      }
    }
    if (options.read !== undefined) {
      let source: string;
      try {
        source = await options.read(record);
      } catch (error) {
        problems.push(
          `${at} (${record.name}): cannot read ${record.repository}@${record.ref}:${record.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const actual = contentSha256(source);
      if (actual !== record.sha256) {
        problems.push(
          `${at} (${record.name}): ${record.repository}@${record.ref}:${record.path} hashes to ${actual}, record says ${record.sha256}`,
        );
      }
    }
  }
  problems.push(...skillDirectoryProblems(checked, profile.resources?.files ?? []));
  return problems;
}

const SKILL_FILE = "SKILL.md";

interface CheckedRecord {
  at: string;
  record: AgentProfileResourceProvenance;
}

type SkillDirectoryRecord = AgentProfileResourceProvenance & { mountedAt: string; siblings: string[] };

/** The checks a skill mounted with its directory adds: every listed file, and only those, mounted beside it. */
function skillDirectoryProblems(
  checked: readonly CheckedRecord[],
  files: readonly AgentProfileFileMount[],
): string[] {
  const problems: string[] = [];
  const skills = new Map<string, { at: string; record: SkillDirectoryRecord }>();
  for (const { at, record } of checked) {
    if (record.mountedAt === undefined || record.siblings === undefined) continue;
    const directoryRecord = record as SkillDirectoryRecord;
    if (skills.has(record.name)) {
      problems.push(`${at} (${record.name}): another record already mounts this skill's directory`);
      continue;
    }
    skills.set(record.name, { at, record: directoryRecord });
  }

  const recorded = new Set<string>();
  for (const { at, record } of checked) {
    if (record.skill === undefined) continue;
    const owner = skills.get(record.skill);
    if (owner === undefined) {
      problems.push(`${at} (${record.name}): skill "${record.skill}" has no record that mounts its directory`);
      continue;
    }
    const skill = owner.record;
    const prefix = `${record.skill}/`;
    const relative = record.name.startsWith(prefix) ? record.name.slice(prefix.length) : undefined;
    if (relative === undefined || !isSafeRelativePath(relative, false) || relative === SKILL_FILE) {
      problems.push(`${at} (${record.name}): the name is not a file inside the directory of skill "${record.skill}"`);
      continue;
    }
    recorded.add(record.name);
    if (!skill.siblings.includes(relative)) {
      problems.push(`${at} (${record.name}): skill "${record.skill}" does not list ${relative} among its files`);
    }
    if (record.repository !== skill.repository || record.ref !== skill.ref) {
      problems.push(
        `${at} (${record.name}): read from ${record.repository}@${record.ref}, but the skill is at ${skill.repository}@${skill.ref}`,
      );
    }
    const directory = sourceDirectory(skill.path);
    const expected = directory === "" ? relative : `${directory}/${relative}`;
    if (record.path !== expected) {
      problems.push(`${at} (${record.name}): source ${record.path} is not ${expected}, beside the skill's ${SKILL_FILE}`);
    }
    const mountPath = `${skill.mountedAt}/${relative}`;
    const mounted = files.filter((file) => file.path === mountPath);
    if (mounted.length === 0) problems.push(`${at} (${record.name}): nothing is mounted at ${mountPath}`);
    for (const file of mounted) {
      if (file.resource.kind !== "inline") {
        problems.push(`${at} (${record.name}): ${mountPath} is not an inline resource`);
        continue;
      }
      const actual = contentSha256(file.resource.content);
      if (actual !== record.sha256) {
        problems.push(`${at} (${record.name}): bytes mounted at ${mountPath} hash to ${actual}, record says ${record.sha256}`);
      }
    }
  }

  for (const { at, record } of skills.values()) {
    const name = record.name;
    if (record.path !== SKILL_FILE && !record.path.endsWith(`/${SKILL_FILE}`)) {
      problems.push(`${at} (${name}): a skill mounted with its directory is read from a ${SKILL_FILE}, not ${record.path}`);
    }
    if (!isSafeRelativePath(record.mountedAt, false) || !record.mountedAt.endsWith(`/${name}`)) {
      problems.push(`${at} (${name}): mountedAt "${record.mountedAt}" is not a workspace directory named for the skill`);
      continue;
    }
    const listed = new Set<string>();
    for (const relative of record.siblings) {
      if (!isSafeRelativePath(relative, false) || relative === SKILL_FILE || listed.has(relative)) {
        problems.push(`${at} (${name}): lists ${JSON.stringify(relative)}, which is not a distinct file inside its directory`);
        continue;
      }
      listed.add(relative);
      if (!recorded.has(`${name}/${relative}`)) {
        problems.push(`${at} (${name}): lists ${relative}, but no record covers ${name}/${relative}`);
      }
    }
    const inside = `${record.mountedAt}/`;
    for (const file of files) {
      if (file.path.startsWith(inside) && !listed.has(file.path.slice(inside.length))) {
        problems.push(`${at} (${name}): ${file.path} is mounted in the skill's directory, but the skill does not list it`);
      }
    }
  }
  return problems;
}

function sourceDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contentSha256(content: string): string {
  return sha256Utf8(content).slice("sha256:".length);
}

function isProvenanceRecord(value: unknown): value is AgentProfileResourceProvenance {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const { mountedAt, siblings, skill } = record;
  const directory =
    mountedAt === undefined && siblings === undefined
      ? true
      : typeof mountedAt === "string" &&
        Array.isArray(siblings) &&
        siblings.every((sibling: unknown) => typeof sibling === "string");
  const member = skill === undefined || (typeof skill === "string" && skill !== "");
  return (
    ["name", "repository", "ref", "path"].every((key) => typeof record[key] === "string" && record[key] !== "") &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    directory &&
    member &&
    // A file of a skill directory is not itself a skill directory.
    !(skill !== undefined && mountedAt !== undefined)
  );
}

/**
 * Inline contents by name. A record names a resource but not its kind, and
 * `mountSkill` records skills, so a skill of that name wins; other kinds are
 * matched only when no skill has the name, so a same-named command or file
 * cannot fail a skill's record.
 */
function inlineResourcesByName(profile: AgentProfile): Map<string, string[]> {
  const resources = profile.resources;
  const others: (AgentProfileResourceRef | undefined)[] = [
    ...(resources?.files?.map((mount) => mount.resource) ?? []),
    ...(resources?.tools ?? []),
    ...(resources?.agents ?? []),
    ...(resources?.commands ?? []),
    typeof resources?.instructions === "object" ? resources.instructions : undefined,
  ];
  const skills = byName(resources?.skills ?? []);
  for (const [name, contents] of byName(others)) {
    if (!skills.has(name)) skills.set(name, contents);
  }
  return skills;
}

function byName(refs: readonly (AgentProfileResourceRef | undefined)[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref?.kind !== "inline") continue;
    map.set(ref.name, [...(map.get(ref.name) ?? []), ref.content]);
  }
  return map;
}
