/**
 * OpenAI `computer_use_preview` tool → internal ComputerUseAction
 * translator.
 *
 * The OpenAI Responses API emits computer-use tool calls with action
 * objects shaped per the `computer_use_preview` spec, e.g.:
 *
 *   { type: "click", x: 100, y: 200, button: "left" }
 *   { type: "drag", path: [{ x: 0, y: 0 }, { x: 50, y: 50 }] }
 *   { type: "scroll", x, y, scroll_x: 0, scroll_y: -3 }
 *   { type: "keypress", keys: ["ENTER"] }
 *
 * These are close to but not identical to the sidecar's internal action
 * shape (`./action.ts`). The differences this translator handles:
 *   - drag.path[] (start + end points) → drag.from/to
 *   - scroll_x/scroll_y → deltaX/deltaY
 *   - click button "wheel"|"back"|"forward" → unsupported error
 *   - cursor_position has no OpenAI equivalent (model uses screenshots)
 */

import {
  ComputerActionTranslationError,
  type ComputerUseAction,
  normalizeKey,
} from "./action.js";

export interface OpenAIComputerInput {
  type: string;
  x?: number;
  y?: number;
  button?: string;
  text?: string;
  keys?: string[];
  path?: Array<{ x: number; y: number }>;
  scroll_x?: number;
  scroll_y?: number;
  ms?: number;
  duration?: number;
}

function requireNumber(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComputerActionTranslationError(
      `OpenAI computer_use action requires numeric "${label}"`,
      "COMPUTER_USE_INVALID_ACTION",
    );
  }
  return value;
}

function requireXY(input: OpenAIComputerInput): { x: number; y: number } {
  return {
    x: requireNumber(input.x, "x"),
    y: requireNumber(input.y, "y"),
  };
}

/**
 * Translate an OpenAI `computer_use_preview` action into the sidecar
 * action. Throws `ComputerActionTranslationError` for unsupported
 * variants (wheel/back/forward buttons) or malformed inputs.
 */
export function translateOpenAIComputerAction(
  input: OpenAIComputerInput,
): ComputerUseAction {
  switch (input.type) {
    case "screenshot":
      return { type: "screenshot" };

    case "click": {
      const { x, y } = requireXY(input);
      const buttonRaw = input.button ?? "left";
      if (
        buttonRaw !== "left" &&
        buttonRaw !== "middle" &&
        buttonRaw !== "right"
      ) {
        throw new ComputerActionTranslationError(
          `OpenAI computer_use click button "${buttonRaw}" is not supported by the sidecar (only left/middle/right)`,
          "COMPUTER_USE_UNSUPPORTED_ACTION",
        );
      }
      return { type: "click", x, y, button: buttonRaw };
    }

    case "double_click":
      return { type: "double_click", ...requireXY(input) };

    case "move":
      return { type: "move", ...requireXY(input) };

    case "drag": {
      if (!Array.isArray(input.path) || input.path.length < 2) {
        throw new ComputerActionTranslationError(
          "OpenAI computer_use drag requires path[] with at least 2 points",
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      const start = input.path[0];
      const end = input.path[input.path.length - 1];
      return {
        type: "drag",
        from: {
          x: requireNumber(start.x, "path[0].x"),
          y: requireNumber(start.y, "path[0].y"),
        },
        to: {
          x: requireNumber(end.x, "path[last].x"),
          y: requireNumber(end.y, "path[last].y"),
        },
      };
    }

    case "type": {
      const text = input.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new ComputerActionTranslationError(
          'OpenAI computer_use type action requires non-empty string "text"',
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      return { type: "type", text };
    }

    case "keypress": {
      if (!Array.isArray(input.keys) || input.keys.length === 0) {
        throw new ComputerActionTranslationError(
          "OpenAI computer_use keypress requires non-empty keys[]",
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      const keys = input.keys.map((k) => {
        if (typeof k !== "string" || k.length === 0) {
          throw new ComputerActionTranslationError(
            "OpenAI computer_use keypress keys[] must be non-empty strings",
            "COMPUTER_USE_INVALID_ACTION",
          );
        }
        return normalizeKey(k);
      });
      return { type: "keypress", keys };
    }

    case "scroll": {
      const { x, y } = requireXY(input);
      const sx =
        typeof input.scroll_x === "number" && Number.isFinite(input.scroll_x)
          ? input.scroll_x
          : 0;
      const sy =
        typeof input.scroll_y === "number" && Number.isFinite(input.scroll_y)
          ? input.scroll_y
          : 0;
      if (sx === 0 && sy === 0) {
        throw new ComputerActionTranslationError(
          "OpenAI computer_use scroll requires non-zero scroll_x or scroll_y",
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      const action: ComputerUseAction = { type: "scroll", x, y };
      if (sy !== 0) action.deltaY = sy;
      if (sx !== 0) action.deltaX = sx;
      return action;
    }

    case "wait": {
      // OpenAI's wait uses `ms`; older preview drafts used `duration`
      // (seconds). Accept both, prefer ms. Match parseAction's strict
      // contract — neither field is a hard validation error rather
      // than a silent default, so the two paths claiming this
      // vocabulary agree.
      if (typeof input.ms === "number" && Number.isFinite(input.ms)) {
        return { type: "wait", ms: Math.max(0, Math.round(input.ms)) };
      }
      if (
        typeof input.duration === "number" &&
        Number.isFinite(input.duration)
      ) {
        return {
          type: "wait",
          ms: Math.max(0, Math.round(input.duration * 1000)),
        };
      }
      throw new ComputerActionTranslationError(
        'OpenAI computer_use wait requires numeric "ms" or "duration"',
        "COMPUTER_USE_INVALID_ACTION",
      );
    }

    default:
      throw new ComputerActionTranslationError(
        `Unknown OpenAI computer_use action type: ${input.type}`,
        "COMPUTER_USE_UNSUPPORTED_ACTION",
      );
  }
}
