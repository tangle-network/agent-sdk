import { describe, expect, it } from "vitest";
import { deepFreeze } from "./deep-freeze.js";

describe("deepFreeze", () => {
  it("freezes nested objects and arrays, not just the top level", () => {
    const document = {
      workspace: { exec: true, git: false },
      kinds: ["question", "permission"],
    };
    deepFreeze(document);

    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.workspace)).toBe(true);
    expect(Object.isFrozen(document.kinds)).toBe(true);
    expect(() => {
      (document.workspace as { git: boolean }).git = true;
    }).toThrow();
    expect(document.workspace.git).toBe(false);
  });

  it("freezes a value that refers back to itself instead of exhausting the stack", () => {
    const parent: Record<string, unknown> = { name: "parent" };
    const child: Record<string, unknown> = { name: "child", parent };
    parent.child = child;

    expect(() => deepFreeze(parent)).not.toThrow(RangeError);
    expect(Object.isFrozen(parent)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("returns a value with no properties to freeze unchanged", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(7)).toBe(7);
    expect(deepFreeze("evidence")).toBe("evidence");
  });
});
