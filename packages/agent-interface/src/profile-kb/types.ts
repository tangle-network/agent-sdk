import type { HarnessType } from "../harness.js";
import type { ReasoningEffort } from "../agent-profile.js";

/** A vendor or measured source, with the date someone read or ran it. */
export interface ProfileKbSource {
  url: string;
  /** ISO date (YYYY-MM-DD) the source was read or the command was run. */
  checkedAt: string;
  /** What the source is, when the URL alone does not say. */
  note?: string;
  /** Authority of the source, independent of whether its claim is advice or a measured result. */
  authority?: "primary" | "secondary" | "local";
  /** Section, source lines, or retained artifact locator supporting the claim. */
  locator?: string;
}

/** A short claim with its qualifications in text, so composition cannot strip them. */
export interface ProfileKbClaim {
  text: string;
  basis: "documented" | "vendor-guidance" | "local-observation" | "hypothesis";
  audience: "agent" | "operator";
  sources: [ProfileKbSource, ...ProfileKbSource[]];
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
  /** Version of the checked CLI or upstream source; claim citations distinguish installation from documentation. */
  version: string;
  sources: ProfileKbSource[];
  prompt: string[];
  operator: string[];
  /** Canonical claims; prompt/operator are projections retained for existing consumers. */
  claims?: ProfileKbClaim[];
}

/** Where a model is reached. A model id means different things on each surface. */
export type ProfileKbSurface = "api" | "codex" | "chatgpt" | "router";

/**
 * How to get the best from one model.
 *
 * API facts, dated observations, and conditional vendor guidance. Sources
 * establish their stated surface, not current availability or task quality.
 */
export interface ProfileKbModel {
  /** Canonical vendor id. */
  id: string;
  name: string;
  vendor: string;
  surfaces: ProfileKbSurface[];
  /** Other spellings that resolve to this model: router ids, harness aliases. */
  aliases: string[];
  /** Documented API default mapped onto the portable scale (ultracode means max); harness defaults can differ. */
  defaultEffort?: ReasoningEffort;
  sources: ProfileKbSource[];
  prompt: string[];
  operator: string[];
  claims?: ProfileKbClaim[];
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
