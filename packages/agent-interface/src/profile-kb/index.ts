/**
 * Profile knowledge base: how to get the best from each frontier harness and
 * model this platform runs, from current vendor sources, composed into an
 * {@link AgentProfile}'s prompt.
 *
 * The data is plain, dated, and sourced. Composition is pure: the same profile
 * yields the same composed profile, so profile identity stays deterministic.
 */

import {
  composeAgentProfileGuidance,
  type AgentProfile,
  type AgentProfileGuidanceBlock,
} from "../agent-profile.js";
import type { HarnessType } from "../harness.js";
import { deepFreeze } from "../deep-freeze.js";
import { harnessSystemPromptIntents } from "../harness-capabilities.js";
import { profileKbHarnesses } from "./harnesses.js";
import { profileKbModels } from "./models.js";
import { profileKbDiscrepancies, profileKbLearnings } from "./records.js";
import type {
  ProfileKbHarness,
  ProfileKbLearning,
  ProfileKbModel,
} from "./types.js";

export type * from "./types.js";
export type {
  AgentProfileGuidanceBlock,
  AgentProfileGuidanceChannel,
  AgentProfileGuidanceOptions,
} from "../agent-profile.js";
export {
  composeAgentProfileGuidance,
  profileKbDiscrepancies,
  profileKbHarnesses,
  profileKbLearnings,
  profileKbModels,
};

/**
 * The guidance block sources the knowledge base owns. {@link withProfileKb}
 * replaces blocks from these sources and keeps blocks any other layer added.
 */
export const PROFILE_KB_SOURCES = ["harness", "model", "learning"] as const;

/*
 * Composition reads a frozen snapshot taken at load, never the exported
 * records. A consumer that edits an exported entry therefore cannot change
 * later compositions or desynchronize the lookup index, and the exported
 * types stay as they were published.
 */
const harnessSnapshot: readonly ProfileKbHarness[] = deepFreeze(
  structuredClone(profileKbHarnesses),
);
const modelSnapshot: readonly ProfileKbModel[] = deepFreeze(
  structuredClone(profileKbModels),
);
const learningSnapshot: readonly ProfileKbLearning[] = deepFreeze(
  structuredClone(profileKbLearnings),
);

function harnessPosition(harness: string): number {
  return harnessSnapshot.findIndex((entry) => entry.id === harness);
}

const modelIndex: ReadonlyMap<string, number> = (() => {
  const index = new Map<string, number>();
  modelSnapshot.forEach((model, position) => {
    for (const name of [model.id, ...model.aliases]) {
      const key = name.toLowerCase();
      if (index.has(key)) {
        throw new Error(`profile-kb: model name ${name} is declared twice`);
      }
      index.set(key, position);
    }
  });
  return index;
})();

/**
 * Try the name as given, then without each leading `provider/` or route
 * segment, after dropping a trailing `:suffix`.
 */
function matchModelName<T>(
  model: string | undefined,
  lookup: (candidate: string) => T | undefined,
): T | undefined {
  if (!model) return undefined;
  const colon = model.lastIndexOf(":");
  let candidate = (colon > 0 ? model.slice(0, colon) : model)
    .trim()
    .toLowerCase();
  for (;;) {
    const found = lookup(candidate);
    if (found !== undefined) return found;
    const slash = candidate.indexOf("/");
    if (slash < 0) return undefined;
    candidate = candidate.slice(slash + 1);
  }
}

function modelPosition(model: string | undefined): number {
  return matchModelName(model, (candidate) => modelIndex.get(candidate)) ?? -1;
}

function learningsFor(
  harness: ProfileKbHarness | undefined,
  model: ProfileKbModel | undefined,
): ProfileKbLearning[] {
  return learningSnapshot.filter((learning) => {
    const scope = learning.appliesTo;
    if (scope.harness !== undefined && scope.harness !== harness?.id) {
      return false;
    }
    if (scope.model !== undefined && scope.model !== model?.id) return false;
    return scope.harness !== undefined || scope.model !== undefined;
  });
}

function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

/** Which harness and model to compose guidance for. */
export interface ProfileKbSelection {
  harness?: HarnessType | string;
  model?: string;
}

/**
 * The guidance blocks for one harness and model: the harness's, then the
 * model's, then any reproduced platform learnings for either. Unknown names
 * contribute nothing.
 */
function profileKbGuidance(
  selection: ProfileKbSelection,
): AgentProfileGuidanceBlock[] {
  const harness = selection.harness
    ? harnessSnapshot[harnessPosition(selection.harness)]
    : undefined;
  const model = modelSnapshot[modelPosition(selection.model)];
  const blocks: AgentProfileGuidanceBlock[] = [];
  if (harness && harness.prompt.length > 0) {
    blocks.push({
      source: "harness",
      id: harness.id,
      text: `Harness guidance: ${harness.name}.\n${bullets(harness.prompt)}`,
    });
  }
  if (model && model.prompt.length > 0) {
    blocks.push({
      source: "model",
      id: model.id,
      text: `Model guidance: ${model.name}.\n${bullets(model.prompt)}`,
    });
  }
  const learnings = learningsFor(harness, model);
  if (learnings.length > 0) {
    blocks.push({
      source: "learning",
      id: learnings.map((learning) => learning.id).join(","),
      text: bullets(learnings.map((learning) => learning.text)),
    });
  }
  return blocks;
}

/**
 * Compose harness, model, and profile guidance into the profile's prompt.
 *
 * The harness and model default to the profile's own `harness` and
 * `model.default`; pass a selection to compose for an executor's override.
 * Guidance goes into `appendSystemPrompt` where the harness owns an additive
 * system-prompt control and into `instructions` otherwise, so a harness that
 * refuses appended system text still receives it. The profile's own text
 * stays last. Recomposing replaces the guidance this function wrote earlier,
 * so the result is stable; blocks from other sources are kept.
 */
export function withProfileKb(
  profile: AgentProfile,
  selection: ProfileKbSelection = {},
): AgentProfile {
  const harness = selection.harness ?? profile.harness;
  const model = selection.model ?? profile.model?.default;
  const blocks = profileKbGuidance({ harness, model });
  const known = harness ? harnessSnapshot[harnessPosition(harness)] : undefined;
  const channel = harnessSystemPromptIntents(
    known?.id ?? (harness as HarnessType | undefined),
  ).append
    ? "appendSystemPrompt"
    : "instructions";
  return composeAgentProfileGuidance(profile, blocks, channel, {
    replaceSources: PROFILE_KB_SOURCES,
  });
}
