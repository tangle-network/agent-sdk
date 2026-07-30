import { describe, expect, it } from "vitest";
import { snapshotAgentProfile } from "./agent-profile-snapshot.js";
import { agentProfileSchema } from "./profile-schema.js";

describe("snapshotAgentProfile", () => {
  it("returns the exact parsed profile without inserting or normalizing values", () => {
    const input = {
      name: "research-leader",
      prompt: { instructions: ["test one hypothesis"] },
      model: { reasoningEffort: "xhigh" as const },
      tools: { execute: true },
      metadata: { explicitUndefined: undefined, negativeZero: -0 },
      extensions: { local: undefined },
    };

    const parsed = agentProfileSchema.parse(input);
    const snapshot = snapshotAgentProfile(input);

    expect(parsed).toStrictEqual(input);
    expect(snapshot).toStrictEqual(input);
    expect(snapshot).toStrictEqual(parsed);
    expect(Object.keys(snapshot)).toEqual(Object.keys(parsed));
    expect(Object.hasOwn(snapshot, "description")).toBe(false);
    expect(Object.hasOwn(snapshot.metadata ?? {}, "explicitUndefined")).toBe(
      true,
    );
    expect(Object.hasOwn(snapshot.extensions ?? {}, "local")).toBe(true);
    expect(Object.is(snapshot.metadata?.negativeZero, -0)).toBe(true);
  });

  it("rejects profiles the canonical schema rejects", () => {
    expect(() =>
      snapshotAgentProfile({
        name: "invalid",
        unknownBehavior: true,
      }),
    ).toThrow();
    expect(() =>
      snapshotAgentProfile({
        tools: { execute: "yes" },
      }),
    ).toThrow();
  });

  it("detaches and freezes nested arrays and record maps", () => {
    const nested = { score: 1 };
    const input = {
      prompt: { instructions: ["initial"] },
      tools: { execute: true },
      metadata: {
        nested,
        map: { result: nested },
      },
    };

    const snapshot = snapshotAgentProfile(input);
    const snapshotNested = snapshot.metadata?.nested as { score: number };
    const snapshotMap = snapshot.metadata?.map as {
      result: { score: number };
    };

    input.prompt.instructions.push("source mutation");
    input.tools.execute = false;
    nested.score = 2;
    input.metadata.map.result = { score: 3 };

    expect(snapshot.prompt?.instructions).toEqual(["initial"]);
    expect(snapshot.tools?.execute).toBe(true);
    expect(snapshotNested.score).toBe(1);
    expect(snapshotMap.result).toBe(snapshotNested);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.prompt)).toBe(true);
    expect(Object.isFrozen(snapshot.prompt?.instructions)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshotNested)).toBe(true);
    expect(Object.isFrozen(snapshotMap)).toBe(true);

    expect(() => snapshot.prompt?.instructions?.push("mutate")).toThrow();
    expect(() => {
      snapshotNested.score = 4;
    }).toThrow();
    expect(() => {
      snapshotMap.result = { score: 4 };
    }).toThrow();
  });

  it("reads untrusted getters once before validation", () => {
    let reads = 0;
    const moving: Record<string, unknown> = {};
    Object.defineProperty(moving, "value", {
      enumerable: true,
      get() {
        reads += 1;
        return { read: reads };
      },
    });

    const snapshot = snapshotAgentProfile({ metadata: { moving } });

    expect(reads).toBe(1);
    expect(snapshot.metadata?.moving).toEqual({ value: { read: 1 } });
    expect(Object.isFrozen(snapshot.metadata?.moving)).toBe(true);
  });

  it("rejects mutable exotic values and cycles outside the portable contract", () => {
    expect(() =>
      snapshotAgentProfile({
        metadata: { map: new Map([["result", 1]]) },
      }),
    ).toThrow(/plain JSON object/);
    expect(() =>
      snapshotAgentProfile({
        metadata: { set: new Set([1]) },
      }),
    ).toThrow(/plain JSON object/);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => snapshotAgentProfile({ metadata: { cycle } })).toThrow(
      /must be acyclic/,
    );
  });
});
