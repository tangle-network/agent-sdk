import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { harnessTypeSchema, recordedHarnessTypeSchema, resolveHarnessType, type HarnessType } from "./harness.js";

import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import { measureAgentProfile } from "./agent-profile-measurements.js";
import { agentProfileSchema, recordedAgentProfileSchema, agentProfileJsonSchema } from "./profile-schema.js";

describe("stable harness identity", () => {
  it("derives the public type from exactly the runtime schema", () => {
    expectTypeOf<HarnessType>().toEqualTypeOf<z.infer<typeof harnessTypeSchema>>();
  });

  it.each(["pi", "prime", "hermes", "cursor", "cli-base"])(
    "keeps historical %s records parseable without an executable or deployment catalog",
    (id) => {
      expect(harnessTypeSchema.parse(id)).toBe(id);
    },
  );

  it("preserves a retired profile and its seat for reads while rejecting new use", () => {
    const profile = {
      harness: "forge",
      model: { provider: "openai", default: "openai/gpt-5" },
      seats: [{ harness: "forge", provider: "openai", model: "openai/gpt-5", selector: { kind: "all-eligible" } }],
    };
    expect(recordedHarnessTypeSchema.parse("forge")).toBe("forge");
    const archived = { harness: "forge" } as const;
    expect(canonicalAgentProfileDigest(archived)).toBe("sha256:f52c40515f7f92a7fe4446c31f8c2542f4ce3b95756d232340b7013ed01b0aa0");
    expect(measureAgentProfile(archived).profileDigest).toBe(canonicalAgentProfileDigest(archived));
    expect(recordedAgentProfileSchema.parse(profile)).toEqual(profile);
    expect(agentProfileSchema.safeParse(profile).success).toBe(false);
    expect(agentProfileJsonSchema.properties?.harness).not.toHaveProperty("enum", expect.arrayContaining(["forge"]));
    for (const id of ["forge", "forgecode", "force"]) expect(resolveHarnessType(id)).toBeNull();
  });

  it.each(["", "unknown-harness", "claude", " pi ", null, 42])(
    "does not invent a recognized identity for %j",
    (id) => {
      expect(harnessTypeSchema.safeParse(id).success).toBe(false);
    },
  );
});
