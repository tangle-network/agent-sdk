import { describe, expect, it } from "vitest";
import {
  ComputerUseError,
  normalizeKey,
  parseAction,
} from "../../src/computer-use/action.js";

describe("parseAction", () => {
  it("accepts screenshot", () => {
    expect(parseAction({ type: "screenshot" })).toEqual({ type: "screenshot" });
  });

  it("accepts cursor_position", () => {
    expect(parseAction({ type: "cursor_position" })).toEqual({
      type: "cursor_position",
    });
  });

  it("accepts click with default left button", () => {
    expect(parseAction({ type: "click", x: 1, y: 2 })).toEqual({
      type: "click",
      x: 1,
      y: 2,
      button: "left",
    });
  });

  it("rejects click with unknown button", () => {
    expect(() =>
      parseAction({ type: "click", x: 1, y: 2, button: "wheel" }),
    ).toThrowError(/button/);
  });

  it("accepts drag", () => {
    expect(
      parseAction({
        type: "drag",
        from: { x: 1, y: 2 },
        to: { x: 3, y: 4 },
      }),
    ).toEqual({
      type: "drag",
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
    });
  });

  it("accepts type with delayMs omitted", () => {
    expect(parseAction({ type: "type", text: "hi" })).toEqual({
      type: "type",
      text: "hi",
      delayMs: undefined,
    });
  });

  it("accepts keypress and normalizes aliases", () => {
    expect(parseAction({ type: "keypress", keys: ["cmd", "c"] })).toEqual({
      type: "keypress",
      keys: ["super", "c"],
    });
  });

  it("rejects keypress with empty keys", () => {
    expect(() => parseAction({ type: "keypress", keys: [] })).toThrowError(
      /non-empty/,
    );
  });

  it("accepts vertical scroll", () => {
    expect(parseAction({ type: "scroll", x: 1, y: 2, deltaY: 3 })).toEqual({
      type: "scroll",
      x: 1,
      y: 2,
      deltaY: 3,
    });
  });

  it("accepts horizontal scroll", () => {
    expect(parseAction({ type: "scroll", x: 1, y: 2, deltaX: -2 })).toEqual({
      type: "scroll",
      x: 1,
      y: 2,
      deltaX: -2,
    });
  });

  it("accepts combined scroll", () => {
    expect(
      parseAction({ type: "scroll", x: 1, y: 2, deltaX: 1, deltaY: 1 }),
    ).toEqual({ type: "scroll", x: 1, y: 2, deltaX: 1, deltaY: 1 });
  });

  it("rejects scroll with no delta", () => {
    expect(() => parseAction({ type: "scroll", x: 1, y: 2 })).toThrowError(
      /at least one non-zero/,
    );
  });

  it("rejects scroll with both deltas equal to zero (silent no-op)", () => {
    // runScroll's wheel-button dispatch skips zero on each axis, so a
    // (0, 0) scroll would silently succeed without moving anything.
    expect(() =>
      parseAction({ type: "scroll", x: 1, y: 2, deltaY: 0, deltaX: 0 }),
    ).toThrowError(/at least one non-zero/);
  });

  it("rejects scroll with explicit deltaY=0 and no deltaX", () => {
    expect(() =>
      parseAction({ type: "scroll", x: 1, y: 2, deltaY: 0 }),
    ).toThrowError(/at least one non-zero/);
  });

  it("strips zero deltaY when deltaX is non-zero (shape parity with translator)", () => {
    expect(
      parseAction({ type: "scroll", x: 1, y: 2, deltaY: 0, deltaX: 5 }),
    ).toEqual({ type: "scroll", x: 1, y: 2, deltaX: 5 });
  });

  it("strips zero deltaX when deltaY is non-zero", () => {
    expect(
      parseAction({ type: "scroll", x: 1, y: 2, deltaY: -3, deltaX: 0 }),
    ).toEqual({ type: "scroll", x: 1, y: 2, deltaY: -3 });
  });

  it("rejects negative wait", () => {
    expect(() => parseAction({ type: "wait", ms: -1 })).toThrowError(
      /non-negative/,
    );
  });

  it("rejects unknown action type", () => {
    expect(() => parseAction({ type: "telekinesis" })).toThrowError(
      /Unknown action type/,
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseAction(null)).toThrow(ComputerUseError);
    expect(() => parseAction("nope")).toThrow(ComputerUseError);
  });

  it("rounds non-integer coordinates", () => {
    const result = parseAction({ type: "click", x: 1.7, y: 2.3 });
    expect(result).toEqual({ type: "click", x: 2, y: 2, button: "left" });
  });
});

describe("normalizeKey", () => {
  it.each([
    ["cmd", "super"],
    ["Command", "super"],
    ["enter", "Return"],
    ["Esc", "Escape"],
    ["pageup", "Prior"],
    ["page_down", "Next"],
    ["a", "a"],
    ["F1", "F1"],
    ["super_l", "super"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });
});
