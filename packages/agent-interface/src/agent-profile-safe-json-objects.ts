import { isWellFormedUnicode } from "./agent-profile-unicode.js";
import {
  AGENT_PROFILE_JSON_MAX_FIELDS,
  AGENT_PROFILE_JSON_MAX_ITEMS,
  AGENT_PROFILE_JSON_MAX_STRING_BYTES,
  AgentProfileJsonError,
} from "./agent-profile-safe-json-limits.js";

const prototypeSensitiveKeys = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export interface StableProperty {
  readonly key: string;
  readonly value: unknown;
}

export interface AgentProfileJsonPath {
  readonly parent?: AgentProfileJsonPath;
  readonly key: string | number;
  readonly depth: number;
}

export interface StableObject {
  readonly array: boolean;
  readonly length?: number;
  readonly properties: readonly StableProperty[];
}

export function appendAgentProfileJsonPath(
  parent: AgentProfileJsonPath | undefined,
  key: string | number,
): AgentProfileJsonPath {
  return {
    ...(parent ? { parent } : {}),
    key,
    depth: (parent?.depth ?? 0) + 1,
  };
}

export function renderAgentProfileJsonPath(
  path: AgentProfileJsonPath | undefined,
): string {
  if (!path) return "root";
  const segments = new Array<string>(path.depth);
  let current: AgentProfileJsonPath | undefined = path;
  for (let index = path.depth - 1; index >= 0; index -= 1) {
    segments[index] = String(current!.key);
    current = current!.parent;
  }
  return segments.join(".");
}

export function inspectStableObject(
  value: object,
  path: AgentProfileJsonPath | undefined,
  rejectPrototypeSensitiveKeys: boolean,
  encoder: TextEncoder,
  accountBytes: (bytes: number) => void,
): StableObject {
  const array = Array.isArray(value);
  let prototype: object | null;
  let firstKeys: readonly PropertyKey[];
  let secondPrototype: object | null;
  let secondKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    firstKeys = Reflect.ownKeys(value);
    assertKeyCount(firstKeys, array, path);
    secondPrototype = Object.getPrototypeOf(value);
    secondKeys = Reflect.ownKeys(value);
    assertKeyCount(secondKeys, array, path);
  } catch (error) {
    if (error instanceof AgentProfileJsonError) throw error;
    throw new AgentProfileJsonError(
      "unstable-object",
      renderAgentProfileJsonPath(path),
      "could not be read as a stable JSON object",
    );
  }
  if (prototype !== secondPrototype || !sameKeys(firstKeys, secondKeys)) {
    throw new AgentProfileJsonError(
      "unstable-object",
      renderAgentProfileJsonPath(path),
      "was changed while it was being detached",
    );
  }

  if (
    (array && prototype !== Array.prototype) ||
    (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new AgentProfileJsonError(
      "invalid-object",
      renderAgentProfileJsonPath(path),
      "must be a plain JSON object or array",
    );
  }

  let firstLengthDescriptor: PropertyDescriptor | undefined;
  let secondLengthDescriptor: PropertyDescriptor | undefined;
  let length: number | undefined;
  if (array) {
    firstLengthDescriptor = descriptor(value, "length", path);
    secondLengthDescriptor = descriptor(value, "length", path);
    if (!sameDescriptor(firstLengthDescriptor, secondLengthDescriptor)) {
      throw new AgentProfileJsonError(
        "unstable-object",
        renderAgentProfileJsonPath(path),
        "changed while its properties were being detached",
      );
    }
    if (
      !Number.isSafeInteger(firstLengthDescriptor.value) ||
      firstLengthDescriptor.value < 0
    ) {
      throw new AgentProfileJsonError(
        "invalid-object",
        renderAgentProfileJsonPath(path),
        "has an invalid array length",
      );
    }
    length = firstLengthDescriptor.value;
    if (length! > AGENT_PROFILE_JSON_MAX_ITEMS) {
      throw new AgentProfileJsonError(
        "item-limit",
        renderAgentProfileJsonPath(path),
        `contains more than ${AGENT_PROFILE_JSON_MAX_ITEMS} items`,
      );
    }
  }

  validateKeys(
    firstKeys,
    array,
    length,
    path,
    rejectPrototypeSensitiveKeys,
    encoder,
    accountBytes,
  );

  const preloadedFirst = firstLengthDescriptor
    ? new Map<PropertyKey, PropertyDescriptor>([["length", firstLengthDescriptor]])
    : undefined;
  const preloadedSecond = secondLengthDescriptor
    ? new Map<PropertyKey, PropertyDescriptor>([["length", secondLengthDescriptor]])
    : undefined;
  const firstDescriptors = descriptors(value, firstKeys, path, preloadedFirst);
  const secondDescriptors = descriptors(value, secondKeys, path, preloadedSecond);
  for (const key of firstKeys) {
    const first = firstDescriptors.get(key)!;
    const second = secondDescriptors.get(key)!;
    if (!sameDescriptor(first, second)) {
      throw new AgentProfileJsonError(
        "unstable-object",
        renderAgentProfileJsonPath(path),
        "changed while its properties were being detached",
      );
    }
  }

  if (array) {
    const properties: StableProperty[] = [];
    for (const key of firstKeys) {
      if (key === "length") continue;
      const index = arrayIndex(key as string)!;
      const descriptor = firstDescriptors.get(key)!;
      if (!descriptor.enumerable) {
        throw new AgentProfileJsonError(
          "invalid-object",
          renderAgentProfileJsonPath(appendAgentProfileJsonPath(path, index)),
          "is not enumerable",
        );
      }
      properties.push({ key: key as string, value: descriptor.value });
      accountBytes(1);
    }
    if (properties.length !== length!) {
      throw new AgentProfileJsonError(
        "sparse-array",
        renderAgentProfileJsonPath(path),
        "must not contain sparse array holes",
      );
    }
    properties.sort((left, right) => Number(left.key) - Number(right.key));
    return { array: true, length: length!, properties };
  }

  const properties: StableProperty[] = [];
  for (const key of firstKeys) {
    const stringKey = key as string;
    const descriptor = firstDescriptors.get(key)!;
    if (!descriptor.enumerable) {
      throw new AgentProfileJsonError(
        "invalid-object",
        renderAgentProfileJsonPath(appendAgentProfileJsonPath(path, stringKey)),
        "is not enumerable",
      );
    }
    properties.push({ key: stringKey, value: descriptor.value });
  }
  return { array: false, properties };
}

function descriptors(
  value: object,
  keys: readonly PropertyKey[],
  path: AgentProfileJsonPath | undefined,
  preloaded?: Map<PropertyKey, PropertyDescriptor>,
): Map<PropertyKey, PropertyDescriptor> {
  const result = new Map(preloaded);
  for (const key of keys) {
    if (result.has(key)) continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new AgentProfileJsonError(
        "unstable-object",
        renderAgentProfileJsonPath(path),
        "could not read a property descriptor",
      );
    }
    if (!descriptor || !("value" in descriptor)) {
      throw new AgentProfileJsonError(
        "unsupported-value",
        renderAgentProfileJsonPath(appendAgentProfileJsonPath(path, String(key))),
        "must not be a getter or setter",
      );
    }
    result.set(key, descriptor);
  }
  return result;
}

function descriptor(
  value: object,
  key: PropertyKey,
  path: AgentProfileJsonPath | undefined,
): PropertyDescriptor {
  let result: PropertyDescriptor | undefined;
  try {
    result = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new AgentProfileJsonError(
      "unstable-object",
      renderAgentProfileJsonPath(path),
      "could not read a property descriptor",
    );
  }
  if (!result || !("value" in result)) {
    throw new AgentProfileJsonError(
      "unsupported-value",
      renderAgentProfileJsonPath(appendAgentProfileJsonPath(path, String(key))),
      "must not be a getter or setter",
    );
  }
  return result;
}

function assertKeyCount(
  keys: readonly PropertyKey[],
  array: boolean,
  path: AgentProfileJsonPath | undefined,
): void {
  const limit = array
    ? AGENT_PROFILE_JSON_MAX_ITEMS + 1
    : AGENT_PROFILE_JSON_MAX_FIELDS;
  if (keys.length <= limit) return;
  throw new AgentProfileJsonError(
    array ? "item-limit" : "field-limit",
    renderAgentProfileJsonPath(path),
    array
      ? `contains more than ${AGENT_PROFILE_JSON_MAX_ITEMS} items`
      : `contains more than ${AGENT_PROFILE_JSON_MAX_FIELDS} fields`,
  );
}

function validateKeys(
  keys: readonly PropertyKey[],
  array: boolean,
  length: number | undefined,
  path: AgentProfileJsonPath | undefined,
  rejectPrototypeSensitiveKeys: boolean,
  encoder: TextEncoder,
  accountBytes: (bytes: number) => void,
): void {
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") {
      throw new AgentProfileJsonError(
        "unsupported-value",
        renderAgentProfileJsonPath(path),
        "contains a symbol property",
      );
    }
    if (array) {
      const index = arrayIndex(key);
      if (index === undefined || index >= length!) {
        throw new AgentProfileJsonError(
          "invalid-object",
          renderAgentProfileJsonPath(path),
          "contains a non-index array property",
        );
      }
      continue;
    }
    const propertyPath = appendAgentProfileJsonPath(path, key);
    if (rejectPrototypeSensitiveKeys && prototypeSensitiveKeys.has(key)) {
      throw new AgentProfileJsonError(
        "prototype-sensitive-key",
        renderAgentProfileJsonPath(propertyPath),
        "uses a prototype-sensitive key",
      );
    }
    if (!isWellFormedUnicode(key)) {
      throw new AgentProfileJsonError(
        "invalid-unicode",
        renderAgentProfileJsonPath(propertyPath),
        "is not valid Unicode",
      );
    }
    const keyBytes = encoder.encode(key).byteLength;
    if (keyBytes > AGENT_PROFILE_JSON_MAX_STRING_BYTES) {
      throw new AgentProfileJsonError(
        "string-limit",
        renderAgentProfileJsonPath(propertyPath),
        `exceeds the maximum string size of ${AGENT_PROFILE_JSON_MAX_STRING_BYTES} bytes`,
      );
    }
    accountBytes(keyBytes);
  }
}

function sameDescriptor(left: PropertyDescriptor, right: PropertyDescriptor): boolean {
  return (
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable &&
    left.writable === right.writable &&
    Object.is(left.value, right.value)
  );
}

function sameKeys(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  return (
    left.length === right.length &&
    left.every((key, index) => key === right[index])
  );
}

function arrayIndex(value: string): number | undefined {
  if (value === "0") return 0;
  if (!/^[1-9][0-9]*$/u.test(value)) return undefined;
  const index = Number(value);
  return Number.isSafeInteger(index) && index <= 4_294_967_294
    ? index
    : undefined;
}
