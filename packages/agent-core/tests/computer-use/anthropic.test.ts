import { describe, expect, it } from "vitest";
import { ComputerActionTranslationError } from "../../src/computer-use/action.js";
import { translateAnthropicComputerAction } from "../../src/computer-use/anthropic.js";

describe("translateAnthropicComputerAction", () => {
  it("screenshot → {type:'screenshot'}", () => {
    expect(translateAnthropicComputerAction({ action: "screenshot" })).toEqual({
      type: "screenshot",
    });
  });

  it("cursor_position → {type:'cursor_position'}", () => {
    expect(
      translateAnthropicComputerAction({ action: "cursor_position" }),
    ).toEqual({ type: "cursor_position" });
  });

  it.each([
    ["left_click", "left"],
    ["right_click", "right"],
    ["middle_click", "middle"],
  ])("%s → click with button=%s", (action, button) => {
    expect(
      translateAnthropicComputerAction({ action, coordinate: [10, 20] }),
    ).toEqual({ type: "click", x: 10, y: 20, button });
  });

  it("double_click → double_click", () => {
    expect(
      translateAnthropicComputerAction({
        action: "double_click",
        coordinate: [3, 4],
      }),
    ).toEqual({ type: "double_click", x: 3, y: 4 });
  });

  it("mouse_move → move", () => {
    expect(
      translateAnthropicComputerAction({
        action: "mouse_move",
        coordinate: [7, 8],
      }),
    ).toEqual({ type: "move", x: 7, y: 8 });
  });

  it("left_click_drag → drag", () => {
    expect(
      translateAnthropicComputerAction({
        action: "left_click_drag",
        start_coordinate: [1, 2],
        coordinate: [9, 9],
      }),
    ).toEqual({
      type: "drag",
      from: { x: 1, y: 2 },
      to: { x: 9, y: 9 },
    });
  });

  it("type → type", () => {
    expect(
      translateAnthropicComputerAction({ action: "type", text: "hello" }),
    ).toEqual({ type: "type", text: "hello" });
  });

  it("key 'cmd+c' → keypress with normalized super+c", () => {
    expect(
      translateAnthropicComputerAction({ action: "key", text: "cmd+c" }),
    ).toEqual({ type: "keypress", keys: ["super", "c"] });
  });

  it("scroll down → positive deltaY", () => {
    expect(
      translateAnthropicComputerAction({
        action: "scroll",
        coordinate: [50, 60],
        scroll_direction: "down",
        scroll_amount: 5,
      }),
    ).toEqual({ type: "scroll", x: 50, y: 60, deltaY: 5 });
  });

  it("scroll up → negative deltaY", () => {
    expect(
      translateAnthropicComputerAction({
        action: "scroll",
        coordinate: [50, 60],
        scroll_direction: "up",
        scroll_amount: 7,
      }),
    ).toEqual({ type: "scroll", x: 50, y: 60, deltaY: -7 });
  });

  it("scroll left → negative deltaX", () => {
    expect(
      translateAnthropicComputerAction({
        action: "scroll",
        coordinate: [10, 10],
        scroll_direction: "left",
        scroll_amount: 4,
      }),
    ).toEqual({ type: "scroll", x: 10, y: 10, deltaX: -4 });
  });

  it("scroll right → positive deltaX", () => {
    expect(
      translateAnthropicComputerAction({
        action: "scroll",
        coordinate: [10, 10],
        scroll_direction: "right",
        scroll_amount: 4,
      }),
    ).toEqual({ type: "scroll", x: 10, y: 10, deltaX: 4 });
  });

  it("scroll defaults to down + magnitude 3", () => {
    expect(
      translateAnthropicComputerAction({
        action: "scroll",
        coordinate: [10, 10],
      }),
    ).toEqual({ type: "scroll", x: 10, y: 10, deltaY: 3 });
  });

  it("missing coordinate → invalid", () => {
    expect(() =>
      translateAnthropicComputerAction({ action: "left_click" }),
    ).toThrow(ComputerActionTranslationError);
  });

  it("type without text → invalid", () => {
    expect(() => translateAnthropicComputerAction({ action: "type" })).toThrow(
      ComputerActionTranslationError,
    );
  });

  it("unknown action → unsupported", () => {
    try {
      translateAnthropicComputerAction({ action: "telekinesis" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ComputerActionTranslationError);
      expect((err as ComputerActionTranslationError).code).toBe(
        "COMPUTER_USE_UNSUPPORTED_ACTION",
      );
    }
  });
});
