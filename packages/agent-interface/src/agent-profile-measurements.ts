import type { Sha256Digest } from "./agent-candidate.js";
import type { AgentProfile, AgentProfileResourceRef } from "./agent-profile.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import { canonicalAgentProfileJson } from "./agent-profile-canonical.js";
import { agentProfileSchema } from "./profile-schema.js";

/** UTF-8 source bytes and logical lines, without normalizing the supplied text. */
export interface AgentProfileTextMeasurement {
  /** RFC 6901 pointer into the measured profile. */
  readonly path: string;
  readonly bytes: number;
  /** Empty text has zero lines; a final line terminator adds no empty line. */
  readonly lines: number;
}

/** A resource declaration; external content has no measured size until resolved. */
export interface AgentProfileResourceMeasurement {
  /** RFC 6901 pointer to the resource or string instruction declaration. */
  readonly path: string;
  readonly kind: "inline" | "github";
  readonly name?: string;
  readonly bytes: number | null;
  readonly lines: number | null;
}

/** Explicit capability declarations, independent of what a harness actually serves. */
export interface AgentProfileCapabilityCounts {
  readonly declared: number;
  readonly enabled: number;
  readonly disabled: number;
}

/**
 * Content-free measurements of one exact AgentProfile value. Apply separately
 * to authored and effective profiles, linked by their existing receipt digests.
 * This declaration neither proves materialization nor observes capability use.
 */
export interface AgentProfileMeasurements {
  readonly version: 1;
  readonly basis: "profile-declaration";
  readonly profileDigest: Sha256Digest;
  /** Bytes of canonical profile JSON, not mounted context or billed input tokens. */
  readonly canonicalBytes: number;
  readonly prompt: readonly AgentProfileTextMeasurement[];
  readonly tools: AgentProfileCapabilityCounts;
  readonly mcp: AgentProfileCapabilityCounts;
  readonly subagents: { readonly declared: number };
  readonly resources: readonly AgentProfileResourceMeasurement[];
  readonly coverage: {
    readonly tokens: "not-measured";
    readonly materialization: "not-assessed";
    readonly usage: "not-assessed";
  };
}

const utf8 = new TextEncoder();

function textMeasurement(path: string, text: string): AgentProfileTextMeasurement {
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return {
    path,
    bytes: utf8.encode(text).byteLength,
    lines: text.length === 0 ? 0 : breaks + (/[\r\n]$/.test(text) ? 0 : 1),
  };
}

function resourceMeasurement(
  path: string,
  resource: AgentProfileResourceRef,
): AgentProfileResourceMeasurement {
  const text = resource.kind === "inline"
    ? textMeasurement(path, resource.content)
    : undefined;
  return {
    path,
    kind: resource.kind,
    ...(resource.name === undefined ? {} : { name: resource.name }),
    bytes: text?.bytes ?? null,
    lines: text?.lines ?? null,
  };
}

function capabilityCounts(enabled: readonly boolean[]): AgentProfileCapabilityCounts {
  const count = enabled.filter(Boolean).length;
  return { declared: enabled.length, enabled: count, disabled: enabled.length - count };
}

/**
 * Measure a canonical profile without resolving resources, reading files, or
 * estimating tokens. Validates the same public profile contract used for
 * identity. Cache by profileDigest; requesting another summary needs no scan.
 * Results preserve declaration order and contain no prompt/resource content,
 * server configuration, permission values, or secret references.
 */
export function measureAgentProfile(profile: AgentProfile): AgentProfileMeasurements {
  const value = agentProfileSchema.parse(profile);
  const profileDigest = canonicalAgentProfileDigest(value);
  const canonical = canonicalAgentProfileJson(value)!;
  const prompt: AgentProfileTextMeasurement[] = [];
  for (const key of ["systemPrompt", "appendSystemPrompt"] as const) {
    const text = value.prompt?.[key];
    if (text !== undefined) prompt.push(textMeasurement(`/prompt/${key}`, text));
  }
  value.prompt?.instructions?.forEach((text, index) => {
    prompt.push(textMeasurement(`/prompt/instructions/${index}`, text));
  });

  const resources: AgentProfileResourceMeasurement[] = [];
  value.resources?.files?.forEach((file, index) => {
    resources.push(resourceMeasurement(`/resources/files/${index}/resource`, file.resource));
  });
  for (const group of ["tools", "skills", "agents", "commands"] as const) {
    value.resources?.[group]?.forEach((resource, index) => {
      resources.push(resourceMeasurement(`/resources/${group}/${index}`, resource));
    });
  }
  const instructions = value.resources?.instructions;
  if (instructions !== undefined) {
    resources.push(typeof instructions === "string"
      ? { kind: "inline", ...textMeasurement("/resources/instructions", instructions) }
      : resourceMeasurement("/resources/instructions", instructions));
  }

  return {
    version: 1,
    basis: "profile-declaration",
    profileDigest,
    canonicalBytes: utf8.encode(canonical).byteLength,
    prompt,
    tools: capabilityCounts(Object.values(value.tools ?? {})),
    mcp: capabilityCounts(Object.values(value.mcp ?? {}).map((server) => server.enabled !== false)),
    subagents: { declared: Object.keys(value.subagents ?? {}).length },
    resources,
    coverage: {
      tokens: "not-measured",
      materialization: "not-assessed",
      usage: "not-assessed",
    },
  };
}
