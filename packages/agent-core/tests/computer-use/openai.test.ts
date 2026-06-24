import { describe, expect, it } from "vitest";
import { ComputerActionTranslationError } from "../../src/computer-use/action.js";
import { translateOpenAIComputerAction } from "../../src/computer-use/openai.js";

describe("translateOpenAIComputerAction", () => {
  it("screenshot → screenshot", () => {
    expect(translateOpenAIComputerAction({ type: "screenshot" })).toEqual({
      type: "screenshot",
    });
  });

  it("click with default left button", () => {
    expect(
      translateOpenAIComputerAction({ type: "click", x: 10, y: 20 }),
    ).toEqual({
      type: "click",
      x: 10,
      y: 20,
      button: "left",
    });
  });

  it("click with explicit right button", () => {
    expect(
      translateOpenAIComputerAction({
        type: "click",
        x: 1,
        y: 2,
        button: "right",
      }),
    ).toEqual({ type: "click", x: 1, y: 2, button: "right" });
  });

  it("click with wheel button is unsupported", () => {
    expect(() =>
      translateOpenAIComputerAction({
        type: "click",
        x: 1,
        y: 2,
        button: "wheel",
      }),
    ).toThrow(ComputerActionTranslationError);
  });

  it("double_click", () => {
    expect(
      translateOpenAIComputerAction({ type: "double_click", x: 5, y: 6 }),
    ).toEqual({ type: "double_click", x: 5, y: 6 });
  });

  it("move", () => {
    expect(translateOpenAIComputerAction({ type: "move", x: 7, y: 8 })).toEqual(
      { type: "move", x: 7, y: 8 },
    );
  });

  it("drag with path[] of two points → from/to", () => {
    expect(
      translateOpenAIComputerAction({
        type: "drag",
        path: [
          { x: 0, y: 0 },
          { x: 50, y: 50 },
        ],
      }),
    ).toEqual({
      type: "drag",
      from: { x: 0, y: 0 },
      to: { x: 50, y: 50 },
    });
  });

  it("drag with multi-point path collapses to first/last", () => {
    expect(
      translateOpenAIComputerAction({
        type: "drag",
        path: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
          { x: 20, y: 20 },
          { x: 30, y: 30 },
        ],
      }),
    ).toEqual({
      type: "drag",
      from: { x: 0, y: 0 },
      to: { x: 30, y: 30 },
    });
  });

  it("drag with too-short path → invalid", () => {
    expect(() =>
      translateOpenAIComputerAction({ type: "drag", path: [{ x: 0, y: 0 }] }),
    ).toThrow(ComputerActionTranslationError);
  });

  it("type", () => {
    expect(
      translateOpenAIComputerAction({ type: "type", text: "hello" }),
    ).toEqual({ type: "type", text: "hello" });
  });

  it("type with empty text → invalid (parity with Anthropic)", () => {
    expect(() =>
      translateOpenAIComputerAction({ type: "type", text: "" }),
    ).toThrow(ComputerActionTranslationError);
  });

  it("type with missing text → invalid", () => {
    expect(() => translateOpenAIComputerAction({ type: "type" })).toThrow(
      ComputerActionTranslationError,
    );
  });

  it("keypress with normalized aliases", () => {
    expect(
      translateOpenAIComputerAction({
        type: "keypress",
        keys: ["cmd", "Enter"],
      }),
    ).toEqual({ type: "keypress", keys: ["super", "Return"] });
  });

  it("scroll vertical → deltaY", () => {
    expect(
      translateOpenAIComputerAction({
        type: "scroll",
        x: 1,
        y: 2,
        scroll_y: -3,
      }),
    ).toEqual({ type: "scroll", x: 1, y: 2, deltaY: -3 });
  });

  it("scroll horizontal → deltaX", () => {
    expect(
      translateOpenAIComputerAction({
        type: "scroll",
        x: 1,
        y: 2,
        scroll_x: 4,
      }),
    ).toEqual({ type: "scroll", x: 1, y: 2, deltaX: 4 });
  });

  it("scroll combined → deltaX + deltaY", () => {
    expect(
      translateOpenAIComputerAction({
        type: "scroll",
        x: 1,
        y: 2,
        scroll_x: 4,
        scroll_y: -3,
      }),
    ).toEqual({ type: "scroll", x: 1, y: 2, deltaX: 4, deltaY: -3 });
  });

  it("scroll with no delta → invalid", () => {
    expect(() =>
      translateOpenAIComputerAction({ type: "scroll", x: 1, y: 2 }),
    ).toThrow(ComputerActionTranslationError);
  });

  it("wait with ms", () => {
    expect(translateOpenAIComputerAction({ type: "wait", ms: 1500 })).toEqual({
      type: "wait",
      ms: 1500,
    });
  });

  it("wait with duration in seconds", () => {
    expect(
      translateOpenAIComputerAction({ type: "wait", duration: 2 }),
    ).toEqual({ type: "wait", ms: 2000 });
  });

  it("wait with no fields → invalid (parity with parseAction)", () => {
    expect(() => translateOpenAIComputerAction({ type: "wait" })).toThrow(
      ComputerActionTranslationError,
    );
  });

  it("unknown action → unsupported", () => {
    expect(() => translateOpenAIComputerAction({ type: "teleport" })).toThrow(
      ComputerActionTranslationError,
    );
  });
});
