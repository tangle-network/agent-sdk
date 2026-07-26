import { describe, expect, it } from "vitest";

import {
  InteractionFieldSchema,
  validateInteractionAnswer,
  type InteractionAnswerSpec,
} from "./interaction.js";

// @ts-expect-error Removed question adapters must stay outside the shared contract.
type RemovedQuestionAdapter = (typeof import("./interaction.js"))["questionAnswerSpec"];
// @ts-expect-error Removed question shapes must stay outside the shared contract.
type RemovedQuestionShape = (typeof import("./interaction.js"))["LegacyQuestion"];

const selectSpec = (overrides?: {
  allowCustom?: boolean;
  multi?: boolean;
}): InteractionAnswerSpec => ({
  fields: [
    {
      type: "select",
      name: "choice",
      label: "Pick one",
      required: true,
      multi: overrides?.multi,
      allowCustom: overrides?.allowCustom,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ],
});

describe("select field schema", () => {
  it("accepts allowCustom on select fields", () => {
    const parsed = InteractionFieldSchema.parse({
      type: "select",
      name: "choice",
      label: "Pick one",
      allowCustom: true,
      options: [{ value: "a", label: "A" }],
    });
    expect(parsed).toMatchObject({ type: "select", allowCustom: true });
  });
});

describe("validateInteractionAnswer select", () => {
  it("rejects out-of-options values when allowCustom is unset", () => {
    const result = validateInteractionAnswer(selectSpec(), { choice: ["write-in"] });
    expect(result).toEqual({
      ok: false,
      errors: ['field "choice" has invalid option "write-in"'],
    });
  });

  it("accepts declared options regardless of allowCustom", () => {
    expect(validateInteractionAnswer(selectSpec(), { choice: ["a"] })).toEqual({ ok: true });
    expect(
      validateInteractionAnswer(selectSpec({ allowCustom: true }), { choice: ["b"] }),
    ).toEqual({ ok: true });
  });

  it("accepts a write-in value when allowCustom is true", () => {
    const result = validateInteractionAnswer(selectSpec({ allowCustom: true }), {
      choice: ["my own answer"],
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a mix of declared and write-in values on multi selects", () => {
    const result = validateInteractionAnswer(
      selectSpec({ allowCustom: true, multi: true }),
      { choice: ["a", "something else"] },
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects blank write-ins even when allowCustom is true", () => {
    const result = validateInteractionAnswer(selectSpec({ allowCustom: true }), {
      choice: ["   "],
    });
    expect(result).toEqual({
      ok: false,
      errors: ['field "choice" has blank write-in value'],
    });
  });

  it("still enforces single-value and required rules with allowCustom", () => {
    expect(
      validateInteractionAnswer(selectSpec({ allowCustom: true }), {
        choice: ["x", "y"],
      }),
    ).toEqual({ ok: false, errors: ['field "choice" accepts a single value'] });
    expect(
      validateInteractionAnswer(selectSpec({ allowCustom: true }), { choice: [] }),
    ).toEqual({ ok: false, errors: ['field "choice" requires a selection'] });
  });
});
