/**
 * Portable sandbox size vocabulary.
 *
 * A size preset is a provider-neutral NAME for a compute tier (cpu / memory /
 * disk). This module owns only the vocabulary — the names and their smallest→
 * largest ordering — so the lowest shared layer can reference a size without
 * depending on the sandbox SDK (`Capability.recommendedSize` lives here, and
 * agent-interface must not depend on `@tangle-network/sandbox`).
 *
 * The concrete cpu/memory/disk numbers for each preset are the sandbox SDK's
 * single source of truth (`@tangle-network/sandbox` → `SANDBOX_SIZE_PRESETS`),
 * which imports these names. Mirrors how this package owns the `ReasoningEffort`
 * vocabulary while backends own its native mapping.
 */

/** Compute tiers, ordered smallest → largest. */
export const SANDBOX_SIZE_PRESET_NAMES = [
  "nano",
  "small",
  "medium",
  "large",
] as const;

/**
 * A named compute tier for a sandbox. `nano` suits thin glue work (a single API
 * call, a notify); `large` suits heavy builds over big repositories. Sizing is a
 * per-task decision — a thin workflow step should not provision a maxed box.
 */
export type SandboxSizePreset = (typeof SANDBOX_SIZE_PRESET_NAMES)[number];
