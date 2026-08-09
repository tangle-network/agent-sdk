import type {
  AgentProfile,
  AgentProfilePrompt,
  AgentProfileResources,
  AgentProfileResourceRef,
} from "./agent-profile.js";
import { mergeAgentProfiles } from "./agent-profile.js";
import { canonicalAgentProfileJson } from "./agent-profile-canonical.js";

type AgentProfileIdentityProperty = "name" | "description" | "version" | "tags";
type AgentProfileDiffPropertyAxis = Exclude<keyof AgentProfile, AgentProfileIdentityProperty>;

const agentProfileDiffPropertyAxes = [
  "prompt",
  "model",
  "harness",
  "permissions",
  "tools",
  "mcp",
  "connections",
  "subagents",
  "resources",
  "hooks",
  "modes",
  "confidential",
  "metadata",
  "extensions",
] as const satisfies readonly AgentProfileDiffPropertyAxis[];

type MissingAgentProfileDiffPropertyAxis = Exclude<
  AgentProfileDiffPropertyAxis,
  (typeof agentProfileDiffPropertyAxes)[number]
>;
const _agentProfileDiffPropertyAxesAreExhaustive: MissingAgentProfileDiffPropertyAxis extends never
  ? true
  : never = true;
void _agentProfileDiffPropertyAxesAreExhaustive;

export type AgentProfileDiffAxis =
  | "identity"
  | (typeof agentProfileDiffPropertyAxes)[number];

export type AgentProfileRemoveList = true | readonly string[];

export interface AgentProfilePromptRemoval {
  systemPrompt?: true;
  appendSystemPrompt?: true;
  instructions?: AgentProfileRemoveList;
}

export interface AgentProfileResourceRemoval {
  files?: AgentProfileRemoveList;
  tools?: AgentProfileRemoveList;
  skills?: AgentProfileRemoveList;
  agents?: AgentProfileRemoveList;
  commands?: AgentProfileRemoveList;
  instructions?: true;
  failOnError?: true;
}

export interface AgentProfileDiffRemoval {
  identity?: true;
  tags?: AgentProfileRemoveList;
  prompt?: true | AgentProfilePromptRemoval;
  model?: AgentProfileRemoveList;
  harness?: true;
  permissions?: AgentProfileRemoveList;
  tools?: AgentProfileRemoveList;
  mcp?: AgentProfileRemoveList;
  connections?: AgentProfileRemoveList;
  subagents?: AgentProfileRemoveList;
  resources?: true | AgentProfileResourceRemoval;
  hooks?: AgentProfileRemoveList;
  modes?: AgentProfileRemoveList;
  confidential?: true;
  metadata?: AgentProfileRemoveList;
  extensions?: AgentProfileRemoveList;
}

/**
 * A portable profile improvement artifact.
 *
 * `set` is an AgentProfile overlay: profile arrays are appended with the same
 * semantics as {@link mergeAgentProfiles}. `remove` deletes whole axes or named
 * entries after the overlay is applied. This keeps the optimized unit the full
 * AgentProfile instead of a benchmark-specific file mount.
 */
export interface AgentProfileDiff {
  kind: "agent-profile-diff";
  id?: string;
  title?: string;
  description?: string;
  rationale?: string;
  source?: {
    kind:
      | "trace"
      | "frontier-author"
      | "human"
      | "optimizer"
      | "compound";
    artifacts?: readonly string[];
    notes?: readonly string[];
  };
  set?: AgentProfile;
  remove?: AgentProfileDiffRemoval;
  metadata?: Record<string, unknown>;
}

export function defineAgentProfileDiff<T extends AgentProfileDiff>(diff: T): T {
  return diff;
}

const agentProfilePromptDiffPropertyAxes = [
  "systemPrompt",
  "appendSystemPrompt",
  "instructions",
] as const satisfies readonly (keyof AgentProfilePrompt)[];

type MissingAgentProfilePromptDiffPropertyAxis = Exclude<
  keyof AgentProfilePrompt,
  (typeof agentProfilePromptDiffPropertyAxes)[number]
>;
const _agentProfilePromptDiffPropertyAxesAreExhaustive:
  MissingAgentProfilePromptDiffPropertyAxis extends never ? true : never = true;
void _agentProfilePromptDiffPropertyAxesAreExhaustive;

const agentProfileResourceDiffPropertyAxes = [
  "files",
  "tools",
  "skills",
  "agents",
  "commands",
  "instructions",
  "failOnError",
] as const satisfies readonly (keyof AgentProfileResources)[];

type MissingAgentProfileResourceDiffPropertyAxis = Exclude<
  keyof AgentProfileResources,
  (typeof agentProfileResourceDiffPropertyAxes)[number]
>;
const _agentProfileResourceDiffPropertyAxesAreExhaustive:
  MissingAgentProfileResourceDiffPropertyAxis extends never ? true : never = true;
void _agentProfileResourceDiffPropertyAxesAreExhaustive;

/**
 * Construct deterministic ordered profile patches that reproduce `candidate`'s
 * canonical profile value exactly when applied to `baseline`.
 *
 * Profile overlays append arrays and merge records, so changed fields are reset
 * first and then replaced. Comparison and copied values follow the same
 * undefined-entry normalization as profile identity. The returned values use
 * the existing {@link AgentProfileDiff} contract; an unchanged profile returns
 * no steps.
 */
export function diffAgentProfiles(
  baseline: AgentProfile,
  candidate: AgentProfile,
): AgentProfileDiff[] {
  const remove: AgentProfileDiffRemoval = {};
  const set: AgentProfile = {};

  if (
    profileValuesDiffer(baseline.name, candidate.name) ||
    profileValuesDiffer(baseline.description, candidate.description) ||
    profileValuesDiffer(baseline.version, candidate.version)
  ) {
    remove.identity = true;
    if (candidate.name !== undefined) set.name = candidate.name;
    if (candidate.description !== undefined) {
      set.description = candidate.description;
    }
    if (candidate.version !== undefined) set.version = candidate.version;
  }

  if (profileValuesDiffer(baseline.tags, candidate.tags)) {
    remove.tags = true;
    if (candidate.tags !== undefined) {
      set.tags = canonicalProfileValue(candidate.tags);
    }
  }

  for (const axis of agentProfileDiffPropertyAxes) {
    if (axis === "resources") {
      replaceChangedProfileResources(
        baseline.resources,
        candidate.resources,
        remove,
        set,
      );
      continue;
    }
    if (!profileValuesDiffer(baseline[axis], candidate[axis])) continue;
    Object.assign(remove, { [axis]: true });
    const value = candidate[axis];
    if (value !== undefined) {
      Object.assign(set, { [axis]: canonicalProfileValue(value) });
    }
  }

  if (Object.keys(remove).length === 0) return [];

  const reset: AgentProfileDiff = {
    kind: "agent-profile-diff",
    remove,
  };
  if (Object.keys(set).length === 0) return [reset];
  return [reset, { kind: "agent-profile-diff", set }];
}

function replaceChangedProfileResources(
  baseline: AgentProfileResources | undefined,
  candidate: AgentProfileResources | undefined,
  remove: AgentProfileDiffRemoval,
  set: AgentProfile,
): void {
  if (!profileValuesDiffer(baseline, candidate)) return;

  const resourceRemove: AgentProfileResourceRemoval = {};
  const resourceSet: AgentProfileResources = {};
  let changedSubfields = 0;

  for (const axis of agentProfileResourceDiffPropertyAxes) {
    if (!profileValuesDiffer(baseline?.[axis], candidate?.[axis])) continue;
    changedSubfields += 1;
    Object.assign(resourceRemove, { [axis]: true });
    const value = candidate?.[axis];
    if (value !== undefined) {
      Object.assign(resourceSet, { [axis]: canonicalProfileValue(value) });
    }
  }

  // Distinguish an absent resources object from an explicitly empty one.
  if (changedSubfields === 0) {
    remove.resources = true;
    if (candidate !== undefined) {
      set.resources = canonicalProfileValue(candidate);
    }
    return;
  }

  remove.resources = resourceRemove;
  const canonicalCandidate = canonicalProfileValue(candidate);
  if (
    Object.keys(resourceSet).length > 0 ||
    (canonicalCandidate !== undefined &&
      Object.keys(canonicalCandidate).length === 0)
  ) {
    set.resources = resourceSet;
  }
}

function profileValuesDiffer(baseline: unknown, candidate: unknown): boolean {
  return (
    canonicalAgentProfileJson(baseline) !== canonicalAgentProfileJson(candidate)
  );
}

function canonicalProfileValue<T>(value: T): T {
  const json = canonicalAgentProfileJson(value);
  return (json === undefined ? undefined : JSON.parse(json)) as T;
}

function asMutable<T>(value: readonly T[] | undefined): T[] | undefined {
  return value ? [...value] : undefined;
}

function removeKeys<T extends object>(
  record: T | undefined,
  removal: AgentProfileRemoveList | undefined,
): T | undefined {
  if (!record || removal === undefined) return record;
  if (removal === true) return undefined;
  const next: Record<string, unknown> = {
    ...(record as Record<string, unknown>),
  };
  for (const key of removal) delete next[key];
  return Object.keys(next).length > 0 ? (next as T) : undefined;
}

function removeValues(
  values: string[] | undefined,
  removal: AgentProfileRemoveList | undefined,
): string[] | undefined {
  if (!values || removal === undefined) return values;
  if (removal === true) return undefined;
  const removeSet = new Set(removal);
  const next = values.filter((value) => !removeSet.has(value));
  return next.length > 0 ? next : undefined;
}

function resourceName(resource: AgentProfileResourceRef): string | undefined {
  return resource.kind === "inline" ? resource.name : resource.name ?? resource.path;
}

function removeResourceRefs<T extends AgentProfileResourceRef>(
  refs: T[] | undefined,
  removal: AgentProfileRemoveList | undefined,
): T[] | undefined {
  if (!refs || removal === undefined) return refs;
  if (removal === true) return undefined;
  const removeSet = new Set(removal);
  const next = refs.filter((ref) => {
    const name = resourceName(ref);
    return !(name && removeSet.has(name));
  });
  return next.length > 0 ? next : undefined;
}

function removeResources(
  resources: AgentProfileResources | undefined,
  removal: true | AgentProfileResourceRemoval | undefined,
): AgentProfileResources | undefined {
  if (!resources || removal === undefined) return resources;
  if (removal === true) return undefined;

  const next: AgentProfileResources = { ...resources };
  if (removal.files !== undefined) {
    if (removal.files === true) {
      delete next.files;
    } else {
      const removeSet = new Set(removal.files);
      setOrDelete(
        next,
        "files",
        next.files?.filter((file) => {
          const name = resourceName(file.resource);
          return !removeSet.has(file.path) && !(name && removeSet.has(name));
        }),
      );
    }
  }
  setOrDelete(next, "tools", removeResourceRefs(next.tools, removal.tools));
  setOrDelete(next, "skills", removeResourceRefs(next.skills, removal.skills));
  setOrDelete(next, "agents", removeResourceRefs(next.agents, removal.agents));
  setOrDelete(
    next,
    "commands",
    removeResourceRefs(next.commands, removal.commands),
  );
  if (removal.instructions) delete next.instructions;
  if (removal.failOnError) delete next.failOnError;

  for (const key of [
    "files",
    "tools",
    "skills",
    "agents",
    "commands",
  ] as const) {
    if (next[key]?.length === 0) delete next[key];
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Write a resolved optional value, or drop the key when the value is gone.
 *
 * Removal deletes the key instead of blanking it: profile identity is an RFC
 * 8785 digest over own keys, so a key left behind holding `undefined` either
 * changes that digest or is refused by the canonical JSON domain.
 */
function setOrDelete<T extends object, K extends keyof T>(
  target: Partial<T>,
  key: K,
  value: T[K] | undefined,
): void {
  if (value === undefined) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function applyRemoval(profile: AgentProfile, remove?: AgentProfileDiffRemoval): AgentProfile {
  if (!remove) return profile;
  const next: AgentProfile = { ...profile };

  if (remove.identity) {
    delete next.name;
    delete next.description;
    delete next.version;
  }
  if (remove.tags !== undefined) {
    setOrDelete(next, "tags", removeValues(asMutable(next.tags), remove.tags));
  }

  if (remove.prompt === true) {
    delete next.prompt;
  } else if (remove.prompt && next.prompt) {
    const prompt: AgentProfilePrompt = { ...next.prompt };
    if (remove.prompt.systemPrompt) delete prompt.systemPrompt;
    if (remove.prompt.appendSystemPrompt) delete prompt.appendSystemPrompt;
    setOrDelete(
      prompt,
      "instructions",
      removeValues(prompt.instructions, remove.prompt.instructions),
    );
    setOrDelete(
      next,
      "prompt",
      Object.keys(prompt).length > 0 ? prompt : undefined,
    );
  }

  if (remove.model !== undefined) {
    setOrDelete(next, "model", removeKeys(next.model, remove.model));
  }
  if (remove.harness !== undefined) delete next.harness;
  if (remove.permissions !== undefined) {
    setOrDelete(
      next,
      "permissions",
      removeKeys(next.permissions, remove.permissions),
    );
  }
  if (remove.tools !== undefined) {
    setOrDelete(next, "tools", removeKeys(next.tools, remove.tools));
  }
  if (remove.mcp !== undefined) {
    setOrDelete(next, "mcp", removeKeys(next.mcp, remove.mcp));
  }
  if (remove.subagents !== undefined) {
    setOrDelete(next, "subagents", removeKeys(next.subagents, remove.subagents));
  }
  if (remove.resources !== undefined) {
    setOrDelete(
      next,
      "resources",
      removeResources(next.resources, remove.resources),
    );
  }
  if (remove.hooks !== undefined) {
    setOrDelete(next, "hooks", removeKeys(next.hooks, remove.hooks));
  }
  if (remove.modes !== undefined) {
    setOrDelete(next, "modes", removeKeys(next.modes, remove.modes));
  }
  if (remove.confidential) delete next.confidential;
  if (remove.metadata !== undefined) {
    setOrDelete(next, "metadata", removeKeys(next.metadata, remove.metadata));
  }
  if (remove.extensions !== undefined) {
    setOrDelete(
      next,
      "extensions",
      removeKeys(next.extensions, remove.extensions),
    );
  }

  if (next.connections && remove.connections !== undefined) {
    if (remove.connections === true) {
      delete next.connections;
    } else {
      const removeSet = new Set(remove.connections);
      const filtered = next.connections.filter(
        (connection) =>
          !removeSet.has(connection.connectionId) &&
          !(connection.alias && removeSet.has(connection.alias)),
      );
      setOrDelete(
        next,
        "connections",
        filtered.length > 0 ? filtered : undefined,
      );
    }
  }

  return next;
}

export function applyAgentProfileDiff(
  base: AgentProfile,
  diff: AgentProfileDiff,
): AgentProfile {
  const merged = mergeAgentProfiles(base, diff.set) ?? {};
  return applyRemoval(merged, diff.remove);
}

function hasRemovalOperation(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") {
    return Object.values(value).some(hasRemovalOperation);
  }
  return false;
}

export function changedAgentProfileAxes(diff: AgentProfileDiff): AgentProfileDiffAxis[] {
  const axes = new Set<AgentProfileDiffAxis>();
  const set = diff.set;
  if (set) {
    if (
      set.name !== undefined ||
      set.description !== undefined ||
      set.version !== undefined ||
      set.tags !== undefined
    ) {
      axes.add("identity");
    }
    for (const axis of agentProfileDiffPropertyAxes) {
      if (set[axis] !== undefined) axes.add(axis);
    }
  }
  const remove = diff.remove;
  if (remove) {
    if (hasRemovalOperation(remove.identity) || hasRemovalOperation(remove.tags)) {
      axes.add("identity");
    }
    for (const axis of agentProfileDiffPropertyAxes) {
      if (hasRemovalOperation(remove[axis])) axes.add(axis);
    }
  }
  return [...axes].sort();
}

export function pruneAgentProfileDiff(
  diff: AgentProfileDiff,
  axesToRemove: readonly AgentProfileDiffAxis[],
): AgentProfileDiff {
  const removeSet = new Set(axesToRemove);
  const set = diff.set ? { ...diff.set } : undefined;
  const remove = diff.remove ? { ...diff.remove } : undefined;

  if (removeSet.has("identity") && set) {
    delete set.name;
    delete set.description;
    delete set.version;
    delete set.tags;
  }
  if (removeSet.has("identity") && remove) {
    delete remove.identity;
    delete remove.tags;
  }

  for (const axis of agentProfileDiffPropertyAxes) {
    if (!removeSet.has(axis)) continue;
    if (set) delete set[axis];
    if (remove) delete remove[axis];
  }

  const pruned: AgentProfileDiff = { ...diff };
  setOrDelete(
    pruned,
    "set",
    set && Object.values(set).some((value) => value !== undefined)
      ? set
      : undefined,
  );
  setOrDelete(
    pruned,
    "remove",
    remove && Object.values(remove).some((value) => value !== undefined)
      ? remove
      : undefined,
  );
  return pruned;
}
