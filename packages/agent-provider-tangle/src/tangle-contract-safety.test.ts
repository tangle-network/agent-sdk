import { describe, expect, it } from "vitest";
import {
  assertCreateInputShape,
  assertNoInlineSecretValues,
} from "./tangle-create-options.js";
import {
  assertBoundedJson,
  isBoundedJson,
  MAX_ARRAY_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_MAP_ENTRIES,
  MAX_STRING_LENGTH,
} from "./tangle-contract-safety.js";

/**
 * What a rejection has to tell the operator who reads it.
 *
 * `assertBoundedJson` threw one unparameterised string — "value exceeds its JSON bound" — for
 * eleven structurally different rejections, four of which are not overruns at all. The walker
 * computed the offending path and then discarded it, because `isBoundedJson` returns a boolean.
 *
 * Measured cost, run mech-interp-foundations-loop-c-20260914b (2026-09-14): three checker children
 * died at spawn in 413 / 102 / 444 ms with zero iterations, zero tokens and $0, after $22.56 of
 * earlier work. Every one recorded the same five words. The cause was a single mounted brief,
 * `resources.files[0].resource.content`, at 20,872 characters against MAX_STRING_LENGTH 16,384 —
 * one violation, at one path, in a 35-node profile whose every other bound had wide margin. None
 * of that reached the record, so the director read `infra: true`, steered a corpse for twelve
 * minutes, and spawned a replacement that died identically.
 *
 * The module had no test file of its own; its bounds were exercised only through the loose
 * matcher /JSON bound/ in leaf-modules.test.ts and tangle-events.test.ts, which one message
 * satisfies as well as eleven. That is why this went unseen.
 */

/** The recorded child profile's shape, with the mounted brief's real size and synthetic bytes. */
function profileWithOversizedBrief(content = "x".repeat(20_872)) {
  return {
    name: "checker",
    description: "independent checker",
    prompt: "check the bundle",
    model: { provider: "anthropic", id: "claude-opus-4" },
    harness: { kind: "claude-code" },
    resources: {
      files: [
        { path: "checker_bundle.csv", resource: { kind: "inline", name: "checker_bundle.csv", content } },
        { path: "analyze_s1.py", resource: { kind: "inline", name: "analyze_s1.py", content: "y".repeat(5_884) } },
        { path: "stake_text.md", resource: { kind: "inline", name: "stake_text.md", content: "z".repeat(4_680) } },
      ],
    },
  };
}

function thrownMessage(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection, got none");
}

/** Every rejection the walker can reach, one value each, none of which overlaps another rule. */
function deepValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let level = 0; level < depth; level += 1) value = { nested: value };
  return value;
}

function manyNodes(): unknown {
  // Each object costs the walker ten nodes — itself, its eight leaves, and the marker it pushes to
  // leave the object again — so this clears MAX_JSON_NODES while leaving every array and map bound
  // satisfied with margin. The node count is then the only rule that can reject it.
  const objects = Math.ceil(MAX_JSON_NODES / 10) + 1;
  return { items: Array.from({ length: objects }, () => Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${index}`, index]))) };
}

function cyclicValue(): unknown {
  const parent: Record<string, unknown> = { child: {} };
  (parent.child as Record<string, unknown>).parent = parent;
  return parent;
}

const REJECTIONS = [
  { rule: "string", path: "note", value: { note: "x".repeat(MAX_STRING_LENGTH + 1) }, overrun: true },
  { rule: "array", path: "items", value: { items: new Array(MAX_ARRAY_LENGTH + 1).fill(0) }, overrun: true },
  { rule: "entries", path: "config", value: { config: Object.fromEntries(Array.from({ length: MAX_MAP_ENTRIES + 1 }, (_, index) => [`k${index}`, index])) }, overrun: true },
  { rule: "depth", path: "nested", value: deepValue(MAX_JSON_DEPTH + 1), overrun: true },
  { rule: "nodes", path: "items", value: manyNodes(), overrun: true },
  { rule: "key", path: "config", value: { config: { ["k".repeat(MAX_IDENTIFIER_LENGTH + 1)]: 1 } }, overrun: true },
  { rule: "undefined", path: "note", value: { note: undefined }, overrun: false },
  { rule: "number", path: "score", value: { score: Number.NaN }, overrun: false },
  { rule: "cycle", path: "child", value: cyclicValue(), overrun: false },
  { rule: "prototype", path: "when", value: { when: new Date(0) }, overrun: false },
] as const;

describe("bounded JSON rejections name what they rejected", () => {
  it("names the rule, the path, the size, and the limit for the profile that killed three children", () => {
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithOversizedBrief() } as never));
    expect(message).toContain("string");
    expect(message).toContain("resources.files[0].resource.content");
    expect(message).toContain("20872");
    expect(message).toContain("16384");
  });

  it("gives each rejection its own message, and calls only overruns an overrun", () => {
    const messages = REJECTIONS.map(({ value }) => thrownMessage(() => assertBoundedJson(value)));
    for (const [index, rejection] of REJECTIONS.entries()) {
      expect(messages[index], `${rejection.rule} must name its rule`).toContain(rejection.rule);
      expect(messages[index], `${rejection.rule} must name its path`).toContain(rejection.path);
      if (rejection.overrun) {
        expect(messages[index], `${rejection.rule} must name its limit`).toMatch(/limit \d+/u);
      } else {
        // A Date, a cycle, a NaN and an absent value are not oversized. Saying "exceeds" sends the
        // reader looking for a size problem that does not exist.
        expect(messages[index], `${rejection.rule} is not an overrun`).not.toContain("exceeds");
      }
    }
    expect(new Set(messages).size, "every rejection must be distinguishable in a run record").toBe(REJECTIONS.length);
  });

  it("keeps the /JSON bound/ substring every existing assertion matches on", () => {
    for (const { value } of REJECTIONS) {
      expect(() => assertBoundedJson(value)).toThrow(/JSON bound/u);
    }
  });

  it("leaves the boolean verdict every branching call site depends on unchanged", () => {
    for (const { value } of REJECTIONS) expect(isBoundedJson(value)).toBe(false);
    expect(isBoundedJson({ ok: "x".repeat(MAX_STRING_LENGTH) })).toBe(true);
    expect(isBoundedJson({ ok: new Array(MAX_ARRAY_LENGTH).fill(0) })).toBe(true);
    expect(isBoundedJson(deepValue(MAX_JSON_DEPTH))).toBe(true);
    expect(isBoundedJson({ ok: { ["k".repeat(MAX_IDENTIFIER_LENGTH)]: 1 } })).toBe(true);
    expect(isBoundedJson(null)).toBe(true);
  });

  it("reports the first violation in document order, not whichever sibling the stack held last", () => {
    const value = { a: "x".repeat(MAX_STRING_LENGTH + 1), b: new Array(MAX_ARRAY_LENGTH + 1).fill(0) };
    const message = thrownMessage(() => assertBoundedJson(value));
    expect(message).toContain(" a ");
    expect(message).not.toContain(" b ");
  });
});

describe("a rejection reason discloses no payload", () => {
  const sentinel = "SECRET-PROMPT-TEXT-";
  const secret = sentinel.repeat(1_099);

  it("names the size of an oversized string without echoing any of it", () => {
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithOversizedBrief(secret) } as never));
    expect(message).not.toContain(sentinel);
    for (let start = 0; start + 24 <= secret.length; start += 1) {
      expect(message.includes(secret.slice(start, start + 24)), `leaked a window at ${start}`).toBe(false);
    }
    expect(message).toContain(String(secret.length));
  });

  it("locates an over-long key without echoing the key, which is itself the rejected value", () => {
    const key = `SECRET-KEY-${"k".repeat(MAX_IDENTIFIER_LENGTH)}`;
    const message = thrownMessage(() => assertBoundedJson({ config: { [key]: 1 } }));
    expect(message).not.toContain("SECRET-KEY");
    expect(message).toContain(String(key.length));
  });

  it("stays a line, not a dump", () => {
    for (const { value } of REJECTIONS) {
      const message = thrownMessage(() => assertBoundedJson(value));
      expect(message.length, message.slice(0, 80)).toBeLessThanOrEqual(512);
      expect(message).not.toContain("\n");
    }
    expect(thrownMessage(() => assertCreateInputShape({ profile: profileWithOversizedBrief(secret) } as never)).length).toBeLessThanOrEqual(512);
  });
});

describe("a rejection says which field was rejected", () => {
  const oversized = { note: "x".repeat(MAX_STRING_LENGTH + 1) };

  it("carries a caller label, because a flattened cause chain renders only name and message", () => {
    expect(thrownMessage(() => assertBoundedJson(oversized, "profile")))
      .not.toBe(thrownMessage(() => assertBoundedJson(oversized, "metadata")));
  });

  it("distinguishes the create-path call sites that share the walker", () => {
    const profile = thrownMessage(() => assertCreateInputShape({ profile: { ...profileWithOversizedBrief() } } as never));
    const providerOptions = thrownMessage(() => assertNoInlineSecretValues({ providerOptions: oversized } as never));
    expect(profile).not.toBe(providerOptions);
    expect(profile).toContain("profile");
    expect(providerOptions).toContain("providerOptions");
  });

  it("survives the runtime's cause flattening as one readable line", () => {
    // agent-runtime's errMessage (supervise/scope.ts) renders a wrapped cause exactly this way,
    // and the result is the `reason` an operator reads in observer.jsonl.
    const cause = new Error(thrownMessage(() => assertCreateInputShape({ profile: profileWithOversizedBrief() } as never)));
    const reason = `retained provider execution requires reconciliation before replacement: caused by ${cause.name}: ${cause.message}`;
    expect(reason).not.toContain("\n");
    expect(reason).toContain("resources.files[0].resource.content");
    expect(reason).toContain("20872");
    expect(reason).toContain("16384");
  });
});
