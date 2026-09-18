import { describe, expect, it } from "vitest";
import {
  assertCreateInputShape,
  assertMappedCreateOptions,
  assertNoInlineSecretValues,
} from "./tangle-create-options.js";
import { backendFromTurnProviderOptions } from "./tangle-prompt.js";
import {
  assertBoundedJson,
  JsonBoundError,
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
 *
 * Naming the bound then exposed the bound. MAX_STRING_LENGTH is a CONTROL-PLANE limit — names,
 * identifiers, env values, metadata — and it was also governing DATA: the contents of file mounts
 * and of inline tools, skills, agents, commands and instructions. A 17,894-character Python file
 * was refused, and the refusal arrived after spawn_worker had already returned a worker id, so the
 * caller burned a spawn (agent-sdk#340). Measured 2026-09-17 on Discovery: retyping and
 * base64-encoding files through model output, the workaround, corrupted files and destroyed about
 * 21 child runs in one day. The bounds below are what the transport actually carries.
 */

/**
 * The payload bounds this package must hold, pinned here rather than imported: each number is a
 * statement about what the product can mount, so changing one in the source must fail a test.
 */
const PAYLOAD_STRING_BYTES = 4 * 1024 * 1024;
const INLINE_PAYLOAD_BYTES = 1024 * 1024 - 8 * 1024;
const TOTAL_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** One shared instance: every mount in a fan-out test can reference the same oversized string. */
const OVERSIZED_MOUNT = "x".repeat(PAYLOAD_STRING_BYTES + 1);

/** The recorded child profile's shape, with the mounted brief's real size and synthetic bytes. */
function profileWithBrief(content = "x".repeat(20_872)) {
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

/**
 * The same profile with an oversized CONTROL-PLANE string. `prompt` is instruction text the
 * create request carries whole, so it keeps MAX_STRING_LENGTH and keeps these message tests cheap:
 * the leak check below scans every 24-character window of the rejected value.
 */
function profileWithOversizedPrompt(prompt: string) {
  return { ...profileWithBrief(), prompt };
}

/** One inline resource ref, as `resources.tools | skills | agents | commands` carry them. */
function inlineResource(name: string, content: string) {
  return { kind: "inline", name, content };
}

/** One file mount, as `resources.files` carries them. */
function fileMount(path: string, content: string) {
  return { path, resource: inlineResource(path, content) };
}

function profileWithResources(resources: Record<string, unknown>) {
  return { ...profileWithBrief(), resources };
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
  it("names the rule, the path, the size, and the limit for a mount that is genuinely too large", () => {
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithBrief(OVERSIZED_MOUNT) } as never));
    expect(message).toContain("payload");
    expect(message).toContain("resources.files[0].resource.content");
    expect(message).toContain(String(PAYLOAD_STRING_BYTES + 1));
    expect(message).toContain(String(PAYLOAD_STRING_BYTES));
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
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithOversizedPrompt(secret) } as never));
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
    expect(thrownMessage(() => assertCreateInputShape({ profile: profileWithOversizedPrompt(secret) } as never)).length).toBeLessThanOrEqual(512);
    expect(thrownMessage(() => assertCreateInputShape({ profile: profileWithBrief(OVERSIZED_MOUNT) } as never)).length).toBeLessThanOrEqual(512);
  });
});

describe("a rejection says which field was rejected", () => {
  const oversized = { note: "x".repeat(MAX_STRING_LENGTH + 1) };

  it("carries a caller label, because a flattened cause chain renders only name and message", () => {
    expect(thrownMessage(() => assertBoundedJson(oversized, "profile")))
      .not.toBe(thrownMessage(() => assertBoundedJson(oversized, "metadata")));
  });

  it("distinguishes the create-path call sites that share the walker", () => {
    const profile = thrownMessage(() => assertCreateInputShape({ profile: profileWithOversizedPrompt("p".repeat(MAX_STRING_LENGTH + 1)) } as never));
    const providerOptions = thrownMessage(() => assertNoInlineSecretValues({ providerOptions: oversized } as never));
    expect(profile).not.toBe(providerOptions);
    expect(profile).toContain("profile");
    expect(providerOptions).toContain("providerOptions");
  });

  it("survives the runtime's cause flattening as one readable line", () => {
    // agent-runtime's errMessage (supervise/scope.ts) renders a wrapped cause exactly this way,
    // and the result is the `reason` an operator reads in observer.jsonl.
    const cause = new Error(thrownMessage(() => assertCreateInputShape({ profile: profileWithBrief(OVERSIZED_MOUNT) } as never)));
    const reason = `retained provider execution requires reconciliation before replacement: caused by ${cause.name}: ${cause.message}`;
    expect(reason).not.toContain("\n");
    expect(reason).toContain("resources.files[0].resource.content");
    expect(reason).toContain(String(PAYLOAD_STRING_BYTES + 1));
    expect(reason).toContain(String(PAYLOAD_STRING_BYTES));
  });
});

describe("a rejection is classifiable without reading its message", () => {
  // The supervising runtime names a failed retained execution from the error's structure, never
  // its text (agent-runtime#1204). A plain Error here was filed under "requires reconciliation".
  it("throws a JsonBoundError with a stable name, a code, the label and the whole violation", () => {
    const oversized = { profile: { prompt: "x".repeat(MAX_STRING_LENGTH + 1) } };
    let caught: unknown;
    try {
      assertBoundedJson(oversized, "Tangle create profile");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonBoundError);
    expect(caught).toBeInstanceOf(Error);
    const error = caught as JsonBoundError;
    expect(error.name).toBe("JsonBoundError");
    expect(error.code).toBe("JSON_BOUND_VIOLATION");
    expect(error.label).toBe("Tangle create profile");
    expect(error.violation).toMatchObject({ rule: "string", path: "profile.prompt", limit: MAX_STRING_LENGTH });
    // The message is unchanged for every reader that already matches on it.
    expect(error.message).toMatch(/Tangle create profile exceeds its JSON bound/u);
  });
});


/**
 * What the transport actually carries, measured against @tangle-network/sandbox 0.39.0.
 *
 * Inline `resources.files` are SPLIT OUT of the create POST and materialized afterwards
 * (`splitInlineProfileFileMounts` / `materializeProfileFileMounts`). A mount that still fits a
 * gateway-safe single-shot write rides `POST /files/write`; anything larger rides chunked upload.
 * Inline `tools`, `agents`, `commands` and `instructions` are NOT split — they ride the create POST
 * — and inline `skills` ride the one-shot profile-priming POST. Both are single request bodies
 * under the gateway's 1 MiB cap.
 */
describe("payload content is bounded by bytes, not by the control-plane string length", () => {
  it("accepts the 17,894-character script a sandbox director could not hand a child", () => {
    const script = "s".repeat(17_894);
    expect(() => assertCreateInputShape({ profile: profileWithBrief(script) } as never)).not.toThrow();
  });

  it("accepts the 20,872-character brief that killed three children", () => {
    expect(() => assertCreateInputShape({ profile: profileWithBrief() } as never)).not.toThrow();
  });

  it("accepts a large mount wherever the create path walks a profile", () => {
    const profile = profileWithBrief("s".repeat(17_894));
    expect(() => assertCreateInputShape({ profile } as never)).not.toThrow();
    expect(() => assertMappedCreateOptions({ backend: { type: "opencode", profile } } as never)).not.toThrow();
    // The per-turn override rides the run request, and is walked with the profile one level down.
    const turnProfile = { name: "checker", resources: { files: [fileMount("analyze_s1.py", "s".repeat(17_894))] } };
    expect(() => backendFromTurnProviderOptions({ backend: { profile: turnProfile } })).not.toThrow();
  });

  it("accepts a large inline resource at every site a profile carries one", () => {
    const content = "s".repeat(17_894);
    for (const field of ["tools", "skills", "agents", "commands"]) {
      const profile = profileWithResources({ [field]: [inlineResource("brief", content)] });
      expect(() => assertCreateInputShape({ profile } as never), field).not.toThrow();
    }
    expect(() => assertCreateInputShape({ profile: profileWithResources({ instructions: inlineResource("brief", content) }) } as never)).not.toThrow();
    expect(() => assertCreateInputShape({ profile: profileWithResources({ instructions: content }) } as never)).not.toThrow();
  });

  it("measures a CJK mount in UTF-8 bytes, which is what the transport counts", () => {
    // 20,000 CJK characters are 20,000 UTF-16 code units and 60,000 UTF-8 bytes. `.length` reads
    // the first number; every byte budget on the way to the sandbox reads the second.
    const content = "研".repeat(20_000);
    expect(content.length).toBe(20_000);
    expect(Buffer.byteLength(content, "utf8")).toBe(60_000);
    expect(() => assertCreateInputShape({ profile: profileWithBrief(content) } as never)).not.toThrow();
  });

  it("reports an emoji mount at its UTF-8 weight, not its surrogate-pair count", () => {
    const content = "🙂".repeat(PAYLOAD_STRING_BYTES / 4 + 1);
    expect(content.length).toBe(PAYLOAD_STRING_BYTES / 2 + 2);
    expect(Buffer.byteLength(content, "utf8")).toBe(PAYLOAD_STRING_BYTES + 4);
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithBrief(content) } as never));
    expect(message).toContain(String(PAYLOAD_STRING_BYTES + 4));
    expect(message).not.toContain(String(content.length));
  });

  it("names the file, its size and the limit when a mount is refused", () => {
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithBrief(OVERSIZED_MOUNT) } as never));
    expect(message).toContain("resources.files[0].resource.content");
    expect(message).toContain(String(PAYLOAD_STRING_BYTES + 1));
    expect(message).toContain(String(PAYLOAD_STRING_BYTES));
    // A refusal a caller cannot act on costs another spawn to learn the same thing.
    expect(message).toMatch(/split|fetch/iu);
  });

  it("keeps every control-plane string at MAX_STRING_LENGTH", () => {
    const overrun = "p".repeat(MAX_STRING_LENGTH + 1);
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithOversizedPrompt(overrun) } as never));
    expect(message).toContain("prompt");
    expect(message).toContain(String(MAX_STRING_LENGTH));
    expect(() => assertBoundedJson({ note: overrun }, "Tangle metadata")).toThrow(/JSON bound/u);
    // Only `content` is cargo. A mount's own path and name are control-plane text sitting beside
    // it, and a bound that spilled onto them would be the same mistake in the other direction.
    const mount = { path: overrun, resource: inlineResource(overrun, "s") };
    expect(thrownMessage(() => assertCreateInputShape({ profile: profileWithResources({ files: [mount] }) } as never)))
      .toContain(String(MAX_STRING_LENGTH));
  });

  it("bounds a payload string only where a profile actually carries one", () => {
    // A global flag would let the same bytes through under `metadata`, where nothing materializes
    // them to disk and the control-plane bound is the only thing standing between a caller and an
    // unbounded create request.
    const shaped = { resources: { files: [fileMount("brief.md", "y".repeat(MAX_STRING_LENGTH + 1))] } };
    expect(() => assertBoundedJson(shaped, "Tangle metadata")).toThrow(/JSON bound/u);
    expect(isBoundedJson(shaped)).toBe(false);
  });
});

describe("a payload bound does not become an unbounded payload", () => {
  it("bounds the total across mounts, so an array of them cannot multiply", () => {
    const count = Math.ceil(TOTAL_PAYLOAD_BYTES / PAYLOAD_STRING_BYTES) + 1;
    const content = "x".repeat(PAYLOAD_STRING_BYTES);
    const files = Array.from({ length: count }, (_, index) => fileMount(`part-${index}.bin`, content));
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithResources({ files }) } as never));
    expect(message).toMatch(/total/iu);
    expect(message).toContain(String(TOTAL_PAYLOAD_BYTES));
  });

  it("bounds inline resources by what one create request carries", () => {
    const half = "x".repeat(INLINE_PAYLOAD_BYTES / 2 + 1);
    const skills = [inlineResource("a", half), inlineResource("b", half)];
    const message = thrownMessage(() => assertCreateInputShape({ profile: profileWithResources({ skills }) } as never));
    expect(message).toMatch(/inline/iu);
    expect(message).toContain(String(INLINE_PAYLOAD_BYTES));
    // A mount of the same size is fine: it is written after create, not carried by it.
    expect(() => assertCreateInputShape({ profile: profileWithResources({ files: [fileMount("a.bin", half), fileMount("b.bin", half)] }) } as never)).not.toThrow();
  });

  it("leaves MAX_ARRAY_LENGTH, MAX_MAP_ENTRIES, MAX_JSON_NODES and MAX_JSON_DEPTH in force", () => {
    const files = Array.from({ length: MAX_ARRAY_LENGTH + 1 }, (_, index) => fileMount(`f${index}`, "x"));
    expect(thrownMessage(() => assertCreateInputShape({ profile: profileWithResources({ files }) } as never))).toContain("array");

    const withMetadata = (metadata: unknown) => ({
      ...profileWithResources({ files: [fileMount("brief.md", "x")] }),
      metadata,
    });
    expect(thrownMessage(() => assertCreateInputShape({ profile: withMetadata(manyNodes()) } as never))).toContain("nodes");
    expect(thrownMessage(() => assertCreateInputShape({ profile: withMetadata(deepValue(MAX_JSON_DEPTH + 1)) } as never))).toContain("depth");
    const wide = Object.fromEntries(Array.from({ length: MAX_MAP_ENTRIES + 1 }, (_, index) => [`k${index}`, index]));
    expect(thrownMessage(() => assertCreateInputShape({ profile: withMetadata(wide) } as never))).toContain("entries");
  });
});
