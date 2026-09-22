import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_JSON_MAX_FIELDS,
  AGENT_PROFILE_JSON_MAX_ITEMS,
  AGENT_PROFILE_JSON_MAX_STRING_BYTES,
  AgentProfileJsonError,
  detachAgentProfileJson,
} from "./agent-profile-safe-json.js";
import { parseAgentProfileModelInput } from "./profile-schema.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation-profile.js";
import { snapshotAgentProfile } from "./agent-profile-snapshot.js";

describe("bounded AgentProfile JSON admission", () => {
  it("detaches supported values and rejects unsafe identities before Zod", () => {
    const shared = { value: true };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const getter: Record<string, unknown> = {};
    let getterReads = 0;
    Object.defineProperty(getter, "value", {
      enumerable: true,
      get() {
        getterReads += 1;
        return true;
      },
    });
    let proxyReads = 0;
    const unstable = new Proxy(
      { safe: true },
      {
        ownKeys() {
          proxyReads += 1;
          return proxyReads === 1 ? ["safe"] : ["safe", "__proto__"];
        },
      },
    );
    const rejected: unknown[] = [
      cycle,
      { first: shared, second: shared },
      getter,
      unstable,
      () => true,
      1n,
      Symbol("value"),
      new Date(),
      new Map(),
      new Set(),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "\ud800",
      JSON.parse('{"__proto__":true}'),
    ];

    for (const value of rejected) {
      expect(() => parseAgentProfileModelInput(value)).toThrow(
        AgentProfileJsonError,
      );
    }
    expect(getterReads).toBe(0);
    expect(proxyReads).toBeGreaterThanOrEqual(2);
  });

  it("rejects sparse arrays and non-enumerable properties", () => {
    const sparse = Array<unknown>(2);
    sparse[1] = true;
    expect(() => parseAgentProfileModelInput(sparse)).toThrow(
      /sparse array holes/,
    );

    const hidden: Record<string, unknown> = {};
    Object.defineProperty(hidden, "value", {
      value: true,
      enumerable: false,
    });
    expect(() => parseAgentProfileModelInput(hidden)).toThrow(
      /is not enumerable/,
    );
  });

  it("enforces field, item, string, and cumulative byte limits", () => {
    const atFieldLimit: Record<string, unknown> = {};
    for (let index = 0; index < AGENT_PROFILE_JSON_MAX_FIELDS; index += 1) {
      atFieldLimit[`field${index}`] = true;
    }
    expect(() => detachAgentProfileJson(atFieldLimit)).not.toThrow();
    atFieldLimit[`field${AGENT_PROFILE_JSON_MAX_FIELDS}`] = true;
    expect(() => detachAgentProfileJson(atFieldLimit)).toThrow(
      /field-limit|more than 4096 fields/,
    );

    expect(() => detachAgentProfileJson(new Array(AGENT_PROFILE_JSON_MAX_ITEMS).fill(true))).not.toThrow();
    expect(() =>
      detachAgentProfileJson(new Array(AGENT_PROFILE_JSON_MAX_ITEMS + 1).fill(true)),
    ).toThrow(/item-limit|more than 4096 items/);

    expect(() =>
      detachAgentProfileJson("x".repeat(AGENT_PROFILE_JSON_MAX_STRING_BYTES)),
    ).not.toThrow();
    expect(() =>
      detachAgentProfileJson("x".repeat(AGENT_PROFILE_JSON_MAX_STRING_BYTES + 1)),
    ).toThrow(AgentProfileJsonError);

    const total = [
      "x".repeat(AGENT_PROFILE_JSON_MAX_STRING_BYTES),
      "x".repeat(AGENT_PROFILE_JSON_MAX_STRING_BYTES),
      "x".repeat(AGENT_PROFILE_JSON_MAX_STRING_BYTES),
      "x".repeat(AGENT_PROFILE_JSON_MAX_STRING_BYTES),
    ];
    expect(() => detachAgentProfileJson(total)).toThrow(AgentProfileJsonError);
  });

  it("rejects shape and key byte limits before scanning property descriptors", () => {
    const tooManyFields: Record<string, unknown> = {};
    for (let index = 0; index <= AGENT_PROFILE_JSON_MAX_FIELDS; index += 1) {
      tooManyFields[`field${index}`] = true;
    }
    const fields = countedProxy(tooManyFields);
    expect(() => detachAgentProfileJson(fields.value)).toThrow(
      /more than 4096 fields/,
    );
    expect(fields.counts.ownKeys).toBeLessThanOrEqual(2);
    expect(fields.counts.getOwnPropertyDescriptor).toBeLessThanOrEqual(2);

    const tooManyItems = countedProxy(
      new Array(AGENT_PROFILE_JSON_MAX_ITEMS + 1).fill(true),
    );
    expect(() => detachAgentProfileJson(tooManyItems.value)).toThrow(
      /more than 4096 items/,
    );
    expect(tooManyItems.counts.ownKeys).toBeLessThanOrEqual(2);
    expect(tooManyItems.counts.getOwnPropertyDescriptor).toBeLessThanOrEqual(2);

    const sparseTooManyItems = countedProxy(
      new Array(AGENT_PROFILE_JSON_MAX_ITEMS + 1),
    );
    expect(() => detachAgentProfileJson(sparseTooManyItems.value)).toThrow(
      /more than 4096 items/,
    );
    expect(sparseTooManyItems.counts.ownKeys).toBeLessThanOrEqual(2);
    expect(sparseTooManyItems.counts.getOwnPropertyDescriptor).toBeLessThanOrEqual(2);

    const tooLongKey = countedProxy({
      ["x".repeat(AGENT_PROFILE_JSON_MAX_STRING_BYTES + 1)]: true,
    });
    expect(() => detachAgentProfileJson(tooLongKey.value)).toThrow(
      AgentProfileJsonError,
    );
    expect(tooLongKey.counts.ownKeys).toBe(2);
    expect(tooLongKey.counts.getOwnPropertyDescriptor).toBeLessThanOrEqual(2);
  });

  it("accepts the exact depth boundary and rejects the next level", () => {
    const atLimit = { metadata: { nested: nestedValue(510) } };
    expect(() => parseAgentProfileModelInput(atLimit)).not.toThrow();
    expect(() => snapshotAgentProfile(atLimit)).not.toThrow();
    expect(() => canonicalAgentProfileDigest(atLimit)).not.toThrow();
    const overLimit = { metadata: { nested: nestedValue(511) } };
    expect(() => parseAgentProfileModelInput(overLimit)).toThrow(
      /maximum JSON depth of 512/,
    );
    expect(() => snapshotAgentProfile(overLimit)).toThrow(
      /maximum JSON depth of 512/,
    );
    expect(() => canonicalAgentProfileDigest(overLimit)).toThrow(
      /maximum JSON depth of 512/,
    );
  });
});

function nestedValue(depth: number): unknown {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

function countedProxy<T extends object>(value: T): {
  value: T;
  counts: {
    ownKeys: number;
    getOwnPropertyDescriptor: number;
  };
} {
  const counts = { ownKeys: 0, getOwnPropertyDescriptor: 0 };
  return {
    value: new Proxy(value, {
      ownKeys(target) {
        counts.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        counts.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }),
    counts,
  };
}
