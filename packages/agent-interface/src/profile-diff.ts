import type {
  AgentProfile,
  AgentProfileResources,
  AgentProfileResourceRef,
} from "./agent-profile.js";
import { mergeAgentProfiles } from "./agent-profile.js";

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
] as const;

export type AgentProfileDiffAxis =
  | "identity"
  | (typeof agentProfileDiffPropertyAxes)[number];

export type AgentProfileRemoveList = true | readonly string[];

export interface AgentProfilePromptRemoval {
  systemPrompt?: true;
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
  schemaVersion: 1;
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
      next.files = undefined;
    } else {
      const removeSet = new Set(removal.files);
      next.files = next.files?.filter((file) => {
        const name = resourceName(file.resource);
        return !removeSet.has(file.path) && !(name && removeSet.has(name));
      });
    }
  }
  next.tools = removeResourceRefs(next.tools, removal.tools);
  next.skills = removeResourceRefs(next.skills, removal.skills);
  next.agents = removeResourceRefs(next.agents, removal.agents);
  next.commands = removeResourceRefs(next.commands, removal.commands);
  if (removal.instructions) next.instructions = undefined;
  if (removal.failOnError) next.failOnError = undefined;

  for (const key of [
    "files",
    "tools",
    "skills",
    "agents",
    "commands",
  ] as const) {
    if (next[key]?.length === 0) next[key] = undefined;
  }

  return Object.values(next).some((value) => value !== undefined)
    ? next
    : undefined;
}

function applyRemoval(profile: AgentProfile, remove?: AgentProfileDiffRemoval): AgentProfile {
  if (!remove) return profile;
  const next: AgentProfile = { ...profile };

  if (remove.identity) {
    next.name = undefined;
    next.description = undefined;
    next.version = undefined;
  }
  if (remove.tags !== undefined) {
    next.tags = removeValues(asMutable(next.tags), remove.tags);
  }

  if (remove.prompt === true) {
    next.prompt = undefined;
  } else if (remove.prompt && next.prompt) {
    const prompt = { ...next.prompt };
    if (remove.prompt.systemPrompt) prompt.systemPrompt = undefined;
    prompt.instructions = removeValues(prompt.instructions, remove.prompt.instructions);
    next.prompt = Object.values(prompt).some((value) => value !== undefined)
      ? prompt
      : undefined;
  }

  if (remove.model !== undefined) {
    next.model = removeKeys(next.model, remove.model);
  }
  if (remove.harness !== undefined) next.harness = undefined;
  if (remove.permissions !== undefined) {
    next.permissions = removeKeys(next.permissions, remove.permissions);
  }
  if (remove.tools !== undefined) {
    next.tools = removeKeys(next.tools, remove.tools);
  }
  if (remove.mcp !== undefined) {
    next.mcp = removeKeys(next.mcp, remove.mcp);
  }
  if (remove.subagents !== undefined) {
    next.subagents = removeKeys(next.subagents, remove.subagents);
  }
  if (remove.resources !== undefined) {
    next.resources = removeResources(next.resources, remove.resources);
  }
  if (remove.hooks !== undefined) {
    next.hooks = removeKeys(next.hooks, remove.hooks);
  }
  if (remove.modes !== undefined) {
    next.modes = removeKeys(next.modes, remove.modes);
  }
  if (remove.confidential) next.confidential = undefined;
  if (remove.metadata !== undefined) {
    next.metadata = removeKeys(next.metadata, remove.metadata);
  }
  if (remove.extensions !== undefined) {
    next.extensions = removeKeys(next.extensions, remove.extensions);
  }

  if (next.connections && remove.connections !== undefined) {
    if (remove.connections === true) {
      next.connections = undefined;
    } else {
      const removeSet = new Set(remove.connections);
      const filtered = next.connections.filter(
        (connection) =>
          !removeSet.has(connection.connectionId) &&
          !(connection.alias && removeSet.has(connection.alias)),
      );
      next.connections = filtered.length > 0 ? filtered : undefined;
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

export function changedAgentProfileAxes(diff: AgentProfileDiff): AgentProfileDiffAxis[] {
  const axes = new Set<AgentProfileDiffAxis>();
  const set = diff.set;
  if (set) {
    if (set.name || set.description || set.version || set.tags) axes.add("identity");
    for (const axis of agentProfileDiffPropertyAxes) {
      if (set[axis] !== undefined) axes.add(axis);
    }
  }
  const remove = diff.remove;
  if (remove) {
    if (remove.identity || remove.tags) axes.add("identity");
    for (const axis of agentProfileDiffPropertyAxes) {
      if (remove[axis] !== undefined) axes.add(axis);
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

  return {
    ...diff,
    ...(set && Object.values(set).some((value) => value !== undefined)
      ? { set }
      : { set: undefined }),
    ...(remove && Object.values(remove).some((value) => value !== undefined)
      ? { remove }
      : { remove: undefined }),
  };
}
