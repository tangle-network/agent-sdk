import type { HarnessType } from "../harness.js";
import type { ReasoningEffort } from "../agent-profile.js";

/** A vendor or measured source, with the date someone read or ran it. */
export interface ProfileKbSource {
  url: string;
  /** ISO date (YYYY-MM-DD) the source was read or the command was run. */
  checkedAt: string;
  /** What the source is, when the URL alone does not say. */
  note?: string;
}

/**
 * How to get the best from one harness.
 *
 * `prompt` lines are addressed to the agent running inside the harness and
 * are composed into its profile. `operator` lines are for whoever launches
 * the harness; they are never sent to a model.
 */
export interface ProfileKbHarness {
  id: HarnessType;
  name: string;
  /** Installed version the guidance was checked against. */
  version: string;
  sources: ProfileKbSource[];
  prompt: string[];
  operator: string[];
}

/** Where a model is reached. A model id means different things on each surface. */
export type ProfileKbSurface = "api" | "codex" | "chatgpt" | "router";

/**
 * How to get the best from one model.
 *
 * Vendor guidance only, each entry citing its source and date. The guidance is
 * positive and specific to this model; it never ranks the model against
 * another.
 */
export interface ProfileKbModel {
  /** Canonical vendor id. */
  id: string;
  name: string;
  vendor: string;
  surfaces: ProfileKbSurface[];
  /** Other spellings that resolve to this model: router ids, harness aliases. */
  aliases: string[];
  /** Vendor default reasoning effort, mapped onto the portable scale. */
  defaultEffort?: ReasoningEffort;
  sources: ProfileKbSource[];
  prompt: string[];
  operator: string[];
}

/**
 * A lesson this platform learned itself. It enters the knowledge base only
 * after an agent-eval check reproduced it, and it stays scoped to the
 * harness or model it was measured on.
 */
export interface ProfileKbLearning {
  id: string;
  appliesTo: { harness?: HarnessType; model?: string };
  text: string;
  evidence: {
    /** The agent-eval check that reproduced the lesson. */
    check: string;
    /** Independent reproductions that passed. */
    reproductions: number;
    source: ProfileKbSource;
  };
}

/** A name the platform asked for that a vendor source does not confirm as stated. */
export interface ProfileKbDiscrepancy {
  subject: string;
  requested: string;
  observed: string;
  sources: ProfileKbSource[];
}
