/**
 * Computer-use action schema — single source of truth.
 *
 * The sidecar's REST/MCP routes accept this union; provider translators
 * (Anthropic `computer`, OpenAI `computer_use_preview`) emit it. Keeping
 * the type, validator, and key alias table in one place prevents the
 * three-way drift that previously existed across sidecar + claude-code
 * provider + ad-hoc dispatchers.
 */

export type MouseButton = "left" | "middle" | "right";

export type ComputerUseAction =
  | { type: "screenshot" }
  | { type: "cursor_position" }
  | { type: "click"; x: number; y: number; button?: MouseButton }
  | { type: "double_click"; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | {
      type: "drag";
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  | { type: "type"; text: string; delayMs?: number }
  | { type: "keypress"; keys: string[] }
  | {
      type: "scroll";
      x: number;
      y: number;
      deltaY?: number;
      deltaX?: number;
    }
  | { type: "wait"; ms: number };

export type ComputerUseActionType = ComputerUseAction["type"];

export class ComputerUseError extends Error {
  readonly code: string;
  constructor(message: string, code = "COMPUTER_USE_FAILED") {
    super(message);
    this.name = "ComputerUseError";
    this.code = code;
  }
}

/**
 * Provider-agnostic translation error. Both the Anthropic and OpenAI
 * translators throw this; the sandbox API and MCP server catch it
 * with `instanceof` to surface the failure as a tool result rather
 * than a 5xx.
 */
export class ComputerActionTranslationError extends Error {
  readonly code: string;
  constructor(message: string, code = "COMPUTER_USE_UNSUPPORTED_ACTION") {
    super(message);
    this.name = "ComputerActionTranslationError";
    this.code = code;
  }
}

const VALID_ACTION_TYPES = new Set<ComputerUseActionType>([
  "screenshot",
  "cursor_position",
  "click",
  "double_click",
  "move",
  "drag",
  "type",
  "keypress",
  "scroll",
  "wait",
]);

const VALID_BUTTONS: ReadonlySet<MouseButton> = new Set([
  "left",
  "middle",
  "right",
]);

function ensureFiniteInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComputerUseError(
      `Action field "${label}" must be a finite number, got ${typeof value}`,
      "COMPUTER_USE_INVALID_ACTION",
    );
  }
  return Number.isInteger(value) ? value : Math.round(value);
}

/**
 * Parse and validate an unknown payload into a typed ComputerUseAction.
 * Throws ComputerUseError with COMPUTER_USE_INVALID_ACTION on any
 * structural problem.
 */
export function parseAction(input: unknown): ComputerUseAction {
  if (!input || typeof input !== "object") {
    throw new ComputerUseError(
      "Action must be an object",
      "COMPUTER_USE_INVALID_ACTION",
    );
  }
  const obj = input as Record<string, unknown>;
  const type = obj.type;
  if (
    typeof type !== "string" ||
    !VALID_ACTION_TYPES.has(type as ComputerUseActionType)
  ) {
    throw new ComputerUseError(
      `Unknown action type "${String(type)}". Valid: ${[...VALID_ACTION_TYPES].join(", ")}`,
      "COMPUTER_USE_INVALID_ACTION",
    );
  }

  switch (type as ComputerUseActionType) {
    case "screenshot":
      return { type: "screenshot" };
    case "cursor_position":
      return { type: "cursor_position" };
    case "click": {
      const x = ensureFiniteInt(obj.x, "x");
      const y = ensureFiniteInt(obj.y, "y");
      const button = obj.button ?? "left";
      if (
        typeof button !== "string" ||
        !VALID_BUTTONS.has(button as MouseButton)
      ) {
        throw new ComputerUseError(
          `Invalid button "${String(button)}". Valid: left, middle, right`,
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      return { type: "click", x, y, button: button as MouseButton };
    }
    case "double_click":
      return {
        type: "double_click",
        x: ensureFiniteInt(obj.x, "x"),
        y: ensureFiniteInt(obj.y, "y"),
      };
    case "move":
      return {
        type: "move",
        x: ensureFiniteInt(obj.x, "x"),
        y: ensureFiniteInt(obj.y, "y"),
      };
    case "drag": {
      const from = obj.from as Record<string, unknown> | undefined;
      const to = obj.to as Record<string, unknown> | undefined;
      if (!from || !to) {
        throw new ComputerUseError(
          "drag requires both from and to {x,y}",
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      return {
        type: "drag",
        from: {
          x: ensureFiniteInt(from.x, "from.x"),
          y: ensureFiniteInt(from.y, "from.y"),
        },
        to: {
          x: ensureFiniteInt(to.x, "to.x"),
          y: ensureFiniteInt(to.y, "to.y"),
        },
      };
    }
    case "type": {
      const text = obj.text;
      if (typeof text !== "string") {
        throw new ComputerUseError(
          'type action requires string field "text"',
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      const delayMs =
        obj.delayMs === undefined
          ? undefined
          : ensureFiniteInt(obj.delayMs, "delayMs");
      return { type: "type", text, delayMs };
    }
    case "keypress": {
      const keys = obj.keys;
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new ComputerUseError(
          "keypress requires non-empty keys[] array",
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      const normalized: string[] = [];
      for (const k of keys) {
        if (typeof k !== "string" || k.length === 0) {
          throw new ComputerUseError(
            "keypress keys[] must be non-empty strings",
            "COMPUTER_USE_INVALID_ACTION",
          );
        }
        // Normalize on parse so the sidecar runtime can pass keys
        // straight to xdotool. Translators do their own normalization
        // for the same reason; calling normalizeKey twice is a no-op.
        normalized.push(normalizeKey(k));
      }
      return { type: "keypress", keys: normalized };
    }
    case "scroll": {
      const deltaY =
        obj.deltaY === undefined
          ? undefined
          : ensureFiniteInt(obj.deltaY, "deltaY");
      const deltaX =
        obj.deltaX === undefined
          ? undefined
          : ensureFiniteInt(obj.deltaX, "deltaX");
      // Reject (undefined, 0) on both axes — runScroll's wheel-button
      // dispatch skips zero, so the action would be a silent no-op
      // otherwise. Translators always emit non-zero, but a direct
      // parseAction caller could otherwise dispatch a successful
      // no-op scroll.
      const noY = deltaY === undefined || deltaY === 0;
      const noX = deltaX === undefined || deltaX === 0;
      if (noY && noX) {
        throw new ComputerUseError(
          "scroll requires at least one non-zero deltaY or deltaX",
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      // Treat 0 the same as undefined when shaping the return — runScroll
      // skips both branches on a zero axis, and the OpenAI translator
      // already strips zeros. Keep the on-the-wire shape consistent
      // across both code paths.
      return {
        type: "scroll",
        x: ensureFiniteInt(obj.x, "x"),
        y: ensureFiniteInt(obj.y, "y"),
        ...(deltaY ? { deltaY } : {}),
        ...(deltaX ? { deltaX } : {}),
      };
    }
    case "wait": {
      const ms = ensureFiniteInt(obj.ms, "ms");
      if (ms < 0) {
        throw new ComputerUseError(
          "wait.ms must be non-negative",
          "COMPUTER_USE_INVALID_ACTION",
        );
      }
      return { type: "wait", ms };
    }
  }
}

/**
 * Map common provider key aliases (cmd, enter, page_up, …) onto the X11
 * keysym names xdotool expects. Anything not in the map passes through
 * unchanged so callers can supply real keysyms directly.
 *
 * This is the union of what the sidecar and the claude-code provider
 * each used to maintain separately.
 */
const KEY_ALIASES: Record<string, string> = {
  cmd: "super",
  command: "super",
  win: "super",
  windows: "super",
  meta: "super",
  super_l: "super",
  super_r: "super",
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "Prior",
  page_up: "Prior",
  pagedown: "Next",
  page_down: "Next",
  home: "Home",
  end: "End",
  space: "space",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
};

export function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  return KEY_ALIASES[lower] ?? key;
}
