/**
 * Provenance for inline profile resources.
 *
 * A profile that must materialize synchronously carries its skills as exact
 * inline bytes. The record beside each one names the file and commit the bytes
 * came from and their SHA-256, so an edit to either the inline copy or the
 * source shows up as a mismatch instead of a silent change of behavior.
 * Records live at `extensions[<profile name>].resourceProvenance`.
 */

import { gitObjectSchema, sha256Utf8 } from "./agent-candidate-schema-common.js";
import type { AgentProfile, AgentProfileResourceRef } from "./agent-profile.js";

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
  /** Name of the inline resource the bytes were mounted as. */
  name: string;
  /** Lowercase hex SHA-256 of the content's UTF-8 bytes. */
  sha256: string;
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

/**
 * Every reason a profile's provenance records do not hold; empty when they do.
 *
 * Each record must be pinned to a commit and name inline resources whose bytes
 * hash to it. With `read`, the source file at that commit must hash to it too,
 * which catches a record that was rewritten together with the inline copy.
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
  for (const [index, record] of records.entries()) {
    const at = `extensions.${namespace}.resourceProvenance[${index}]`;
    if (!isProvenanceRecord(record)) {
      problems.push(`${at}: needs string name, repository, ref, path and a 64-hex sha256`);
      continue;
    }
    if (!gitObjectSchema.safeParse(record.ref).success) {
      problems.push(`${at} (${record.name}): ref "${record.ref}" is not a full commit SHA`);
    }
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
  return problems;
}

function contentSha256(content: string): string {
  return sha256Utf8(content).slice("sha256:".length);
}

function isProvenanceRecord(value: unknown): value is AgentProfileResourceProvenance {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    ["name", "repository", "ref", "path"].every((key) => typeof record[key] === "string" && record[key] !== "") &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256)
  );
}

function inlineResourcesByName(profile: AgentProfile): Map<string, string[]> {
  const resources = profile.resources;
  const refs: (AgentProfileResourceRef | undefined)[] = [
    ...(resources?.files?.map((mount) => mount.resource) ?? []),
    ...(resources?.tools ?? []),
    ...(resources?.skills ?? []),
    ...(resources?.agents ?? []),
    ...(resources?.commands ?? []),
    typeof resources?.instructions === "object" ? resources.instructions : undefined,
  ];
  const byName = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref?.kind !== "inline") continue;
    byName.set(ref.name, [...(byName.get(ref.name) ?? []), ref.content]);
  }
  return byName;
}
