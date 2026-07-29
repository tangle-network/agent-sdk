import type { AgentProfile } from "./agent-profile.js";

/**
 * The 29 canonical AgentProfile leaves that can affect one execution.
 *
 * Compound parents such as `model`, `prompt`, and `resources` are deliberately
 * absent. A producer must report the exact requested leaf instead of claiming
 * a parent while silently dropping one of its children.
 */
export const AGENT_PROFILE_MATERIALIZATION_AXES = [
  "name",
  "description",
  "version",
  "tags",
  "systemPrompt",
  "instructions",
  "modelDefault",
  "modelSmall",
  "modelProvider",
  "modelReasoningEffort",
  "modelMetadata",
  "harness",
  "permissions",
  "tools",
  "mcp",
  "connections",
  "subagents",
  "files",
  "resourceTools",
  "skills",
  "resourceAgents",
  "commands",
  "resourceInstructions",
  "resourceFailOnError",
  "hooks",
  "modes",
  "confidential",
  "metadata",
  "extensions",
] as const;

/** One exact leaf of the public AgentProfile contract. */
export type AgentProfileMaterializationAxis =
  (typeof AGENT_PROFILE_MATERIALIZATION_AXES)[number];

/** Compatibility name used by runtimes that distinguish canonical axes. */
export type CanonicalAgentProfileMaterializationAxis =
  AgentProfileMaterializationAxis;

/** One requested profile leaf and its canonical RFC 6901 JSON Pointer. */
export interface AgentProfileMaterializationRequest {
  axis: AgentProfileMaterializationAxis;
  path: string;
}

type AgentProfileIdentityProperty = "name" | "description" | "version" | "tags";
type AgentProfileProperty = Exclude<keyof AgentProfile, AgentProfileIdentityProperty>;

const profileProperties = [
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
] as const satisfies readonly AgentProfileProperty[];

type MissingAgentProfileProperty = Exclude<
  AgentProfileProperty,
  (typeof profileProperties)[number]
>;
const profilePropertiesAreExhaustive: MissingAgentProfileProperty extends never
  ? true
  : never = true;
void profilePropertiesAreExhaustive;

interface AxisDescriptor {
  axis: AgentProfileMaterializationAxis;
  rootPath: string;
  value(profile: AgentProfile): unknown;
}

const AXIS_DESCRIPTORS = [
  { axis: "name", rootPath: "/name", value: (profile) => profile.name },
  {
    axis: "description",
    rootPath: "/description",
    value: (profile) => profile.description,
  },
  { axis: "version", rootPath: "/version", value: (profile) => profile.version },
  { axis: "tags", rootPath: "/tags", value: (profile) => profile.tags },
  {
    axis: "systemPrompt",
    rootPath: "/prompt/systemPrompt",
    value: (profile) => profile.prompt?.systemPrompt,
  },
  {
    axis: "instructions",
    rootPath: "/prompt/instructions",
    value: (profile) => profile.prompt?.instructions,
  },
  {
    axis: "modelDefault",
    rootPath: "/model/default",
    value: (profile) => profile.model?.default,
  },
  {
    axis: "modelSmall",
    rootPath: "/model/small",
    value: (profile) => profile.model?.small,
  },
  {
    axis: "modelProvider",
    rootPath: "/model/provider",
    value: (profile) => profile.model?.provider,
  },
  {
    axis: "modelReasoningEffort",
    rootPath: "/model/reasoningEffort",
    value: (profile) => profile.model?.reasoningEffort,
  },
  {
    axis: "modelMetadata",
    rootPath: "/model/metadata",
    value: (profile) => profile.model?.metadata,
  },
  { axis: "harness", rootPath: "/harness", value: (profile) => profile.harness },
  {
    axis: "permissions",
    rootPath: "/permissions",
    value: (profile) => profile.permissions,
  },
  { axis: "tools", rootPath: "/tools", value: (profile) => profile.tools },
  { axis: "mcp", rootPath: "/mcp", value: (profile) => profile.mcp },
  {
    axis: "connections",
    rootPath: "/connections",
    value: (profile) => profile.connections,
  },
  {
    axis: "subagents",
    rootPath: "/subagents",
    value: (profile) => profile.subagents,
  },
  {
    axis: "files",
    rootPath: "/resources/files",
    value: (profile) => profile.resources?.files,
  },
  {
    axis: "resourceTools",
    rootPath: "/resources/tools",
    value: (profile) => profile.resources?.tools,
  },
  {
    axis: "skills",
    rootPath: "/resources/skills",
    value: (profile) => profile.resources?.skills,
  },
  {
    axis: "resourceAgents",
    rootPath: "/resources/agents",
    value: (profile) => profile.resources?.agents,
  },
  {
    axis: "commands",
    rootPath: "/resources/commands",
    value: (profile) => profile.resources?.commands,
  },
  {
    axis: "resourceInstructions",
    rootPath: "/resources/instructions",
    value: (profile) => profile.resources?.instructions,
  },
  {
    axis: "resourceFailOnError",
    rootPath: "/resources/failOnError",
    value: (profile) => profile.resources?.failOnError,
  },
  { axis: "hooks", rootPath: "/hooks", value: (profile) => profile.hooks },
  { axis: "modes", rootPath: "/modes", value: (profile) => profile.modes },
  {
    axis: "confidential",
    rootPath: "/confidential",
    value: (profile) => profile.confidential,
  },
  {
    axis: "metadata",
    rootPath: "/metadata",
    value: (profile) => profile.metadata,
  },
  {
    axis: "extensions",
    rootPath: "/extensions",
    value: (profile) => profile.extensions,
  },
] as const satisfies readonly AxisDescriptor[];

type MissingAxisDescriptor = Exclude<
  AgentProfileMaterializationAxis,
  (typeof AXIS_DESCRIPTORS)[number]["axis"]
>;
const axisDescriptorsAreExhaustive: MissingAxisDescriptor extends never
  ? true
  : never = true;
void axisDescriptorsAreExhaustive;

/**
 * Return every canonical profile leaf that contains a meaningful request.
 * Every explicit value is a request, including empty strings, empty
 * collections, `null`, `false`, and `0`. Only an absent/undefined leaf is
 * omitted.
 */
export function profileMaterializationAxes(
  profile: AgentProfile,
): readonly AgentProfileMaterializationAxis[] {
  const axes: AgentProfileMaterializationAxis[] = [];
  for (const descriptor of AXIS_DESCRIPTORS) {
    if (descriptor.value(profile) !== undefined) {
      axes.push(descriptor.axis);
    }
  }
  return axes;
}

/**
 * Expand requested axes into exact JSON Pointer paths.
 *
 * Compound maps and arrays produce one row per explicit scalar leaf. An empty
 * compound value produces its axis-root path. This prevents an executor from
 * acknowledging one tool, server, resource, or instruction while claiming the
 * whole axis, without losing an explicit request to clear that axis.
 */
export function profileMaterializationRequests(
  profile: AgentProfile,
): readonly AgentProfileMaterializationRequest[] {
  const requests: AgentProfileMaterializationRequest[] = [];
  for (const descriptor of AXIS_DESCRIPTORS) {
    const paths = materializationValuePaths(
      descriptor.value(profile),
      descriptor.rootPath,
    );
    for (const path of paths) {
      requests.push({ axis: descriptor.axis, path });
    }
  }
  return requests;
}

function materializationValuePaths(root: unknown, rootPath: string): string[] {
  const paths: string[] = [];
  visitMaterializationValue(root, rootPath, [], paths);

  return paths;
}

function visitMaterializationValue(
  value: unknown,
  path: string,
  ancestors: readonly object[],
  paths: string[],
): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== "object") {
    paths.push(path);
    return true;
  }
  if (ancestors.includes(value)) {
    paths.push(path);
    return true;
  }

  const nextAncestors = [...ancestors, value];
  const entries: Array<readonly [string, unknown]> = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => [
        String(index),
        Object.prototype.hasOwnProperty.call(value, index)
          ? value[index]
          : undefined,
      ] as const)
    : Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
  let childRequested = false;
  for (const [key, child] of entries) {
    childRequested =
      visitMaterializationValue(
        child,
        `${path}/${escapeJsonPointerSegment(key)}`,
        nextAncestors,
        paths,
      ) || childRequested;
  }
  if (!childRequested) paths.push(path);
  return true;
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
