/**
 * Anthropic `computer` tool → internal ComputerUseAction translator.
 *
 * The Anthropic Claude API (and `claude-code` CLI when run with the
 * computer-use beta) emits tool-use blocks of the form:
 *
 *   { name: 'computer', input: { action, coordinate?, text?, ... } }
 *
 * This module translates the input shape into the canonical sidecar
 * action vocabulary defined in `./action.ts`. Pure function — no I/O,
 * no side effects.
 */

import {
  ComputerActionTranslationError,
  type ComputerUseAction,
  normalizeKey,
} from "./action.js";

export interface AnthropicComputerInput {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
}

function requireCoordinate(
  input: AnthropicComputerInput,
  field: "coordinate" | "start_coordinate",
): [number, number] {
  const value = input[field];
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number"
  ) {
    throw new ComputerActionTranslationError(
      `Anthropic computer.${input.action} requires "${field}: [x, y]"`,
      "COMPUTER_USE_INVALID_ACTION",
    );
  }
  return value as [number, number];
}

function requireText(input: AnthropicComputerInput): string {
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new ComputerActionTranslationError(
      `Anthropic computer.${input.action} requires non-empty "text"`,
      "COMPUTER_USE_INVALID_ACTION",
    );
  }
  return input.text;
}

/**
 * Translate an Anthropic `computer` tool input into the sidecar action.
 * Throws `ComputerActionTranslationError` for malformed inputs or
 * unrecognized action names; the caller should surface the error as a
 * tool_result with `is_error: true` so the model can react.
 */
export function translateAnthropicComputerAction(
  input: AnthropicComputerInput,
): ComputerUseAction {
  switch (input.action) {
    case "screenshot":
      return { type: "screenshot" };

    case "cursor_position":
      return { type: "cursor_position" };

    case "left_click":
    case "right_click":
    case "middle_click": {
      const [x, y] = requireCoordinate(input, "coordinate");
      const button =
        input.action === "left_click"
          ? "left"
          : input.action === "right_click"
            ? "right"
            : "middle";
      return { type: "click", x, y, button };
    }

    case "double_click": {
      const [x, y] = requireCoordinate(input, "coordinate");
      return { type: "double_click", x, y };
    }

    case "mouse_move": {
      const [x, y] = requireCoordinate(input, "coordinate");
      return { type: "move", x, y };
    }

    case "left_click_drag": {
      const [fromX, fromY] = requireCoordinate(input, "start_coordinate");
      const [toX, toY] = requireCoordinate(input, "coordinate");
      return {
        type: "drag",
        from: { x: fromX, y: fromY },
        to: { x: toX, y: toY },
      };
    }

    case "type":
      return { type: "type", text: requireText(input) };

    case "key": {
      const text = requireText(input);
      const keys = text.split("+").map((token) => normalizeKey(token.trim()));
      return { type: "keypress", keys };
    }

    case "scroll": {
      const [x, y] = requireCoordinate(input, "coordinate");
      const direction = input.scroll_direction ?? "down";
      const magnitude =
        typeof input.scroll_amount === "number" && input.scroll_amount > 0
          ? input.scroll_amount
          : 3;
      switch (direction) {
        case "up":
          return { type: "scroll", x, y, deltaY: -magnitude };
        case "down":
          return { type: "scroll", x, y, deltaY: magnitude };
        case "left":
          return { type: "scroll", x, y, deltaX: -magnitude };
        case "right":
          return { type: "scroll", x, y, deltaX: magnitude };
        default:
          throw new ComputerActionTranslationError(
            `Unknown scroll_direction "${direction}"`,
            "COMPUTER_USE_INVALID_ACTION",
          );
      }
    }

    default:
      throw new ComputerActionTranslationError(
        `Unknown Anthropic computer action: ${input.action}`,
        "COMPUTER_USE_UNSUPPORTED_ACTION",
      );
  }
}
