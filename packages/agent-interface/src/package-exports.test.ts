import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as harness from "./harness.js";
import * as harnessCapabilities from "./harness-capabilities.js";
import * as interaction from "./interaction.js";
import * as interactive from "./environment-interactive.js";
import * as interactiveControl from "./environment-interactive-control.js";
import * as profile from "./agent-profile.js";
import * as profileSchema from "./profile-schema.js";
import * as profileSecurity from "./profile-security.js";
import * as profileSnapshot from "./agent-profile-snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as {
  exports: Record<string, { import: string; types: string }>;
  publishConfig: {
    exports: Record<
      string,
      { import: string; types: string; default: string }
    >;
  };
};

// Each narrow subpath lets a caller load one leaf without evaluating the root
// barrel graph. Runtime resolution of the published dist targets is enforced by
// scripts/check-package-artifacts.mjs, which imports every export specifier from
// an installed tarball. This test pins the export map and the exported symbols.
const subpathLeaves = [
  { subpath: "./environment-interactive", file: "environment-interactive", module: interactive, symbols: ["AgentInteractiveSessionStartSchema", "AgentInteractiveSessionRefSchema"] },
  { subpath: "./environment-interactive-control", file: "environment-interactive-control", module: interactiveControl, symbols: ["AgentInteractiveSessionRefSchema", "AgentInteractiveSessionControlClaimSchema"] },
  { subpath: "./profile", file: "agent-profile", module: profile, symbols: ["REASONING_EFFORTS"] },
  { subpath: "./profile-snapshot", file: "agent-profile-snapshot", module: profileSnapshot, symbols: ["snapshotAgentProfile"] },
  { subpath: "./profile-schema", file: "profile-schema", module: profileSchema, symbols: ["agentProfileSchema", "agentProfileModelHintsSchema", "isCredentialBearingProfileConfigName"] },
  { subpath: "./profile-security", file: "profile-security", module: profileSecurity, symbols: ["validateAgentProfileSecurity", "isRuntimeProcessControlEnvironmentName"] },
  { subpath: "./harness", file: "harness", module: harness, symbols: ["harnessTypeSchema"] },
  { subpath: "./harness-capabilities", file: "harness-capabilities", module: harnessCapabilities, symbols: ["harnessSupportsModel", "reasoningLadder"] },
  { subpath: "./interaction", file: "interaction", module: interaction, symbols: ["InteractionFieldNameSchema", "InteractionDataSchema", "validateInteractionResponse"] },
] as const;

describe("agent-interface narrow subpath exports", () => {
  it("declares each leaf in dev exports and publishConfig exports", () => {
    for (const leaf of subpathLeaves) {
      const dev = manifest.exports[leaf.subpath];
      expect(dev, `${leaf.subpath} dev export`).toBeDefined();
      expect(dev.import).toBe(`./dist/${leaf.file}.js`);
      expect(dev.types).toBe(`./src/${leaf.file}.ts`);

      const published = manifest.publishConfig.exports[leaf.subpath];
      expect(published, `${leaf.subpath} published export`).toBeDefined();
      expect(published.import).toBe(`./dist/${leaf.file}.js`);
      expect(published.types).toBe(`./dist/${leaf.file}.d.ts`);
      expect(published.default).toBe(`./dist/${leaf.file}.js`);
    }
  });

  it("loads each leaf module and exposes its expected symbols", () => {
    for (const leaf of subpathLeaves) {
      const loaded = leaf.module as Record<string, unknown>;
      for (const symbol of leaf.symbols) {
        expect(loaded[symbol], `${leaf.subpath} exports ${symbol}`).toBeDefined();
      }
    }
  });
});
