import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { harnessTypeSchema, type HarnessType } from "./harness.js";

describe("stable harness identity", () => {
  it("derives the public type from exactly the runtime schema", () => {
    expectTypeOf<HarnessType>().toEqualTypeOf<z.infer<typeof harnessTypeSchema>>();
  });

  it.each(["forge", "pi", "prime", "hermes", "cursor", "cli-base"])(
    "keeps historical %s records parseable without an executable or deployment catalog",
    (id) => {
      expect(harnessTypeSchema.parse(id)).toBe(id);
    },
  );

  it.each(["", "unknown-harness", "claude", " pi ", null, 42])(
    "does not invent a recognized identity for %j",
    (id) => {
      expect(harnessTypeSchema.safeParse(id).success).toBe(false);
    },
  );
});
