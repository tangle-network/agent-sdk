import type { HarnessType } from "../harness.js";
import type { ReasoningEffort } from "../agent-profile.js";

/** A vendor or measured source, with the date someone read or ran it. */
export interface ProfileKbSource {
  readonly url: string;
  /** ISO date (YYYY-MM-DD) the source was read or the command was run. */
  readonly checkedAt: string;
  /** What the source is, when the URL alone does not say. */
  readonly note?: string;
}

/**
 * How to get the best from one harness.
 *
 * `prompt` lines are addressed to the agent running inside the harness and
 * are composed into its profile. `operator` lines are for whoever launches
 * the harness; they are never sent to a model.
 */
export interface ProfileKbHarness {
  readonly id: HarnessType;
  readonly name: string;
  /** Installed version the guidance was checked against. */
  readonly version: string;
  readonly sources: readonly ProfileKbSource[];
  readonly prompt: readonly string[];
  readonly operator: readonly string[];
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
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly surfaces: readonly ProfileKbSurface[];
  /** Other spellings that resolve to this model: router ids, harness aliases. */
  readonly aliases: readonly string[];
  /** Vendor default reasoning effort, mapped onto the portable scale. */
  readonly defaultEffort?: ReasoningEffort;
  readonly sources: readonly ProfileKbSource[];
  readonly prompt: readonly string[];
  readonly operator: readonly string[];
}

/**
 * A lesson this platform learned itself. It enters the knowledge base only
 * after an agent-eval check reproduced it, and it stays scoped to the
 * harness or model it was measured on.
 */
export interface ProfileKbLearning {
  readonly id: string;
  readonly appliesTo: { readonly harness?: HarnessType; readonly model?: string };
  readonly text: string;
  readonly evidence: {
    /** The agent-eval check that reproduced the lesson. */
    readonly check: string;
    /** Independent reproductions that passed. */
    readonly reproductions: number;
    readonly source: ProfileKbSource;
  };
}

/** A name the platform asked for that a vendor source does not confirm as stated. */
export interface ProfileKbDiscrepancy {
  readonly subject: string;
  readonly requested: string;
  readonly observed: string;
  readonly sources: readonly ProfileKbSource[];
}
